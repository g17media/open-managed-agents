import { Hono } from "hono";
import type { KvStore } from "@open-managed-agents/kv-store";
import type { BlobStore } from "@open-managed-agents/blob-store";
import { resolveServices } from "../types";
import { kvKey, kvPrefix, kvListAll } from "../lib/kv-helpers";
import {
  persistNewSkill,
  persistNewVersion,
  parseFrontmatter,
  unzipEntriesWithLimits,
  tryDecodeUtf8,
  bytesToBase64Str,
  formatBytesHuman,
  type SkillRoutesDeps,
  type SkillFileInput,
  type SkillMeta,
  type ZipEntry,
} from "./index";

// ---------------------------------------------------------------------------
// GitHub import — fetch a repo zipball, discover every directory containing
// a SKILL.md, and upsert each as a skill (matched by `name`, GitHub wins).
// Reuses the zip limits + persistence from ./index; the only genuinely new
// logic is multi-skill discovery and the name-based upsert.
//
// Kept in its own module (mounted on the same /v1/skills base, before the
// buildSkillRoutes app) so the upstream skills module diff stays minimal.
// ---------------------------------------------------------------------------

/** Provenance for skills imported from a GitHub repository. Stored on the
 *  SkillMeta (like `clawhub_slug` on ClawHub installs) so the sync endpoint
 *  can re-import from the same source and skip no-op writes. Tokens are
 *  NEVER stored — private-repo syncs must supply one per request. */
export interface GitHubSource {
  /** "owner/name" */
  repo: string;
  /** Branch / tag / sha as given at import time. Absent = default branch. */
  ref?: string;
  /** Subdirectory filter within the repo ("" / absent = repo root). */
  path?: string;
  /** Directory of this skill within the repo (repo-relative; "" = root). */
  skill_dir?: string;
  /** Short commit sha of the zipball this version came from. */
  commit?: string;
  /** SHA-256 over this skill's files — sync compares this to skip no-op
   *  version churn when the repo moved but this skill's files didn't. */
  content_hash?: string;
  synced_at?: string;
}

/** Compressed-download cap for GitHub zipballs. The unzip limits in
 *  ./index still apply to the uncompressed contents. */
const GITHUB_ZIP_MAX_BYTES = 50 * 1024 * 1024;

interface ParsedRepoUrl {
  repo: string;
  ref?: string;
  path?: string;
}

/** Accepts `owner/repo`, `https://github.com/owner/repo[.git]`, and
 *  `https://github.com/owner/repo/tree/<ref>[/<path>]`. For tree URLs the
 *  first segment after /tree/ is taken as the ref — branch names containing
 *  slashes need the explicit `ref` field instead. */
function parseGitHubRepoUrl(input: string): ParsedRepoUrl | null {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!trimmed) return null;
  const full = trimmed.match(
    /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)(?:\/(.+))?)?$/,
  );
  if (full) {
    return {
      repo: `${full[1]}/${full[2]}`,
      ref: full[3] || undefined,
      path: full[4] || undefined,
    };
  }
  const bare = trimmed.replace(/\.git$/, "").match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) return { repo: `${bare[1]}/${bare[2]}` };
  return null;
}

async function fetchGitHubZipball(
  repo: string,
  ref: string | undefined,
  token: string | undefined,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; status: number; error: string }> {
  // Encode per-segment so refs like "feat/thing" survive as path segments.
  const refPart = ref
    ? `/${ref.split("/").map(encodeURIComponent).join("/")}`
    : "";
  const url = `https://api.github.com/repos/${repo}/zipball${refPart}`;
  const headers: Record<string, string> = {
    "User-Agent": "open-managed-agents",
    Accept: "application/vnd.github+json",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const hint =
      res.status === 404
        ? " (repo or ref not found — private repos need a token)"
        : res.status === 401 || res.status === 403
          ? " (check the token)"
          : "";
    return { ok: false, status: 502, error: `GitHub zipball fetch failed: ${res.status}${hint}` };
  }
  const len = Number(res.headers.get("content-length") || "0");
  if (len > GITHUB_ZIP_MAX_BYTES) {
    return {
      ok: false,
      status: 400,
      error: `Repo zipball is ${formatBytesHuman(len)}; limit is ${formatBytesHuman(GITHUB_ZIP_MAX_BYTES)}. The whole repo is downloaded regardless of path filter — host skills in a smaller dedicated repo.`,
    };
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > GITHUB_ZIP_MAX_BYTES) {
    return {
      ok: false,
      status: 400,
      error: `Repo zipball is ${formatBytesHuman(bytes.byteLength)}; limit is ${formatBytesHuman(GITHUB_ZIP_MAX_BYTES)}. The whole repo is downloaded regardless of path filter — host skills in a smaller dedicated repo.`,
    };
  }
  return { ok: true, bytes };
}

function sanitizeSkillName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

interface DiscoveredSkill {
  /** Skill directory relative to the repo root ("" = root). */
  dir: string;
  name: string;
  description: string;
  files: SkillFileInput[];
}

/** Find every directory containing a SKILL.md (case-insensitive) and split
 *  the entries into per-skill file sets. Files are assigned to the DEEPEST
 *  enclosing skill directory, so a repo-root SKILL.md coexists with
 *  `skills/foo/SKILL.md` without swallowing foo's files. Entries under no
 *  skill directory are dropped. */
function discoverSkillsInEntries(
  entries: ZipEntry[],
  pathFilter: string | undefined,
  fallbackNameSeed: string,
): DiscoveredSkill[] {
  const pf = (pathFilter ?? "").replace(/^\/+|\/+$/g, "");
  const scoped = pf
    ? entries
        .filter((e) => e.path.startsWith(`${pf}/`))
        .map((e) => ({ path: e.path.slice(pf.length + 1), bytes: e.bytes }))
    : entries;

  const roots = Array.from(
    new Set(
      scoped
        .filter((e) => (e.path.split("/").pop() || "").toLowerCase() === "skill.md")
        .map((e) => e.path.split("/").slice(0, -1).join("/")),
    ),
  // Deepest-first so files land in the most specific skill; "" (root)
  // naturally sorts last and catches the remainder.
  ).sort((a, b) => b.length - a.length);

  const skills: DiscoveredSkill[] = [];
  for (const root of roots) {
    const inRoot = scoped.filter((e) => {
      if (root !== "" && !e.path.startsWith(`${root}/`)) return false;
      // Excluded if a deeper skill root claims this file.
      const owner = roots.find((r) => r === "" || e.path.startsWith(`${r}/`));
      return owner === root;
    });
    const files: SkillFileInput[] = [];
    let skillMdText: string | null = null;
    for (const e of inRoot) {
      const rel = root === "" ? e.path : e.path.slice(root.length + 1);
      if (!rel) continue;
      const decoded = tryDecodeUtf8(e.bytes);
      if (decoded !== null) {
        files.push({ filename: rel, content: decoded, encoding: "utf8" });
        if (rel.toLowerCase() === "skill.md") skillMdText = decoded;
      } else {
        files.push({ filename: rel, content: bytesToBase64Str(e.bytes), encoding: "base64" });
      }
    }
    if (skillMdText === null) continue; // SKILL.md was binary garbage — skip
    const fm = parseFrontmatter(skillMdText);
    const dirBase = root.split("/").pop() || "";
    const name = sanitizeSkillName(fm.name || dirBase || fallbackNameSeed);
    if (!name) continue;
    skills.push({
      dir: pf ? (root ? `${pf}/${root}` : pf) : root,
      name,
      description: fm.description || "",
      files,
    });
  }
  return skills;
}

/** Deterministic SHA-256 over a skill's file set — used to skip no-op
 *  version writes when the repo advanced but this skill's files didn't. */
async function computeSkillContentHash(files: SkillFileInput[]): Promise<string> {
  const parts = [...files]
    .sort((a, b) => a.filename.localeCompare(b.filename))
    .map((f) => `${f.filename} ${f.encoding ?? "utf8"} ${f.content} `);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(parts.join("")),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface ImportSkillResult {
  name: string;
  skill_id: string;
  dir: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  /** Set for skipped (why) and failed (persist error). */
  error?: string;
}

interface ImportSourceArgs {
  repo: string;
  ref?: string;
  path?: string;
  token?: string;
}

/** Fetch + discover + upsert for one (repo, ref, path) source. Upsert is
 *  by skill `name`: an existing tenant skill with the same name gets a new
 *  version (GitHub is the source of truth), a new name is created. Skills
 *  that exist locally but not in the repo are untouched (orphan-and-keep). */
async function importGitHubSource(
  kv: KvStore,
  bucket: BlobStore,
  tenantId: string,
  args: ImportSourceArgs,
): Promise<
  | { ok: true; commit: string; skills: ImportSkillResult[] }
  | { ok: false; status: number; error: string }
> {
  const fetched = await fetchGitHubZipball(args.repo, args.ref, args.token);
  if (!fetched.ok) return fetched;

  let entries: ZipEntry[];
  let rootPrefix: string;
  try {
    ({ entries, rootPrefix } = unzipEntriesWithLimits(fetched.bytes));
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "Failed to read repo zipball",
    };
  }
  // GitHub zipball root folder is `owner-repo-<shortsha>/`.
  const commit = rootPrefix.replace(/\/$/, "").split("-").pop() || "";

  const repoName = args.repo.split("/")[1] || args.repo;
  const discovered = discoverSkillsInEntries(entries, args.path, repoName);
  if (discovered.length === 0) {
    return {
      ok: false,
      status: 400,
      error: `No SKILL.md found in ${args.repo}${args.path ? ` under "${args.path}"` : ""}. Each skill must be a directory containing SKILL.md.`,
    };
  }

  // Existing tenant skills by name for the upsert. When duplicates share a
  // name, prefer the one already tracking this repo so sync keeps updating
  // the row it created rather than hijacking an unrelated manual skill.
  const keys = await kvListAll(kv, kvPrefix(tenantId, "skill"));
  const existing: SkillMeta[] = [];
  for (const k of keys) {
    const data = await kv.get(k.name);
    if (!data) continue;
    try {
      existing.push(JSON.parse(data) as SkillMeta);
    } catch {
      /* unparseable rows are skipped, same as the list endpoint */
    }
  }
  const byName = new Map<string, SkillMeta>();
  for (const s of existing) {
    const prev = byName.get(s.name);
    if (!prev || (s.github_source?.repo === args.repo && prev.github_source?.repo !== args.repo)) {
      byName.set(s.name, s);
    }
  }

  const now = new Date().toISOString();
  const results: ImportSkillResult[] = [];
  // Names already handled this import — two directories whose names
  // sanitize identically would otherwise create duplicates (or update the
  // same skill twice, order-dependent). First directory wins.
  const processedNames = new Map<string, string>();
  for (const d of discovered) {
    const firstDir = processedNames.get(d.name);
    if (firstDir !== undefined) {
      results.push({
        name: d.name,
        skill_id: "",
        dir: d.dir,
        action: "skipped",
        error: `duplicate skill name — already imported from "${firstDir || "(repo root)"}"`,
      });
      continue;
    }
    processedNames.set(d.name, d.dir);

    const contentHash = await computeSkillContentHash(d.files);
    const provenance: GitHubSource = {
      repo: args.repo,
      ...(args.ref ? { ref: args.ref } : {}),
      ...(args.path ? { path: args.path } : {}),
      ...(d.dir ? { skill_dir: d.dir } : {}),
      commit,
      content_hash: contentHash,
      synced_at: now,
    };

    // Per-skill failures are recorded and the loop continues: R2/KV writes
    // aren't transactional across skills, so aborting mid-import would
    // leave earlier writes committed while reporting a global failure.
    const match = byName.get(d.name);
    if (match && match.source === "custom") {
      if (match.github_source?.content_hash === contentHash) {
        // Files identical — refresh provenance (commit / synced_at) and the
        // frontmatter-derived description: parser improvements can change
        // what identical files parse to (e.g. YAML block scalars), and the
        // description should heal without a version bump.
        match.github_source = provenance;
        match.description = d.description;
        await kv.put(kvKey(tenantId, "skill", match.id), JSON.stringify(match));
        results.push({ name: d.name, skill_id: match.id, dir: d.dir, action: "unchanged" });
        continue;
      }
      const r = await persistNewVersion(kv, bucket, tenantId, match.id, {
        files: d.files,
        description: d.description,
        github_source: provenance,
      });
      results.push(
        r.ok
          ? { name: d.name, skill_id: match.id, dir: d.dir, action: "updated" }
          : { name: d.name, skill_id: match.id, dir: d.dir, action: "failed", error: r.error },
      );
    } else {
      const r = await persistNewSkill(kv, bucket, tenantId, {
        files: d.files,
        name: d.name,
        description: d.description,
        github_source: provenance,
        skip_file_readback: true,
      });
      results.push(
        r.ok
          ? { name: d.name, skill_id: r.skill.id, dir: d.dir, action: "created" }
          : { name: d.name, skill_id: "", dir: d.dir, action: "failed", error: r.error },
      );
    }
  }

  return { ok: true, commit, skills: results };
}

/** Sync downloads and unzips a full repo zipball per tracked source, so cap
 *  the fan-out per request — beyond this the tenant should split syncs. */
const SYNC_MAX_SOURCES = 20;

export function buildSkillGitHubRoutes(deps: SkillRoutesDeps) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();

  // ---------------------------------------------------------------------------
  // POST /v1/skills/import/github — one-shot import from a GitHub repo
  // Body: { url, ref?, path?, token? }. `url` also accepts owner/repo and
  // /tree/<ref>/<path> forms; explicit ref/path fields win over URL parts.
  // ---------------------------------------------------------------------------

  app.post("/import/github", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.get("tenant_id");
    const freqCheck = deps.checkUploadFreq ? await deps.checkUploadFreq(t) : null;
    if (freqCheck) return freqCheck;

    const bucket = services.filesBlob ?? null;
    if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

    const body = await c.req.json<{ url?: string; ref?: string; path?: string; token?: string }>();
    if (!body.url) return c.json({ error: "url is required" }, 400);
    const parsed = parseGitHubRepoUrl(body.url);
    if (!parsed) {
      return c.json(
        { error: `"${body.url}" is not a recognizable GitHub repository (expected owner/repo or a github.com URL)` },
        400,
      );
    }

    const ref = body.ref || parsed.ref;
    const path = body.path || parsed.path;
    const result = await importGitHubSource(services.kv, bucket, t, {
      repo: parsed.repo,
      ref,
      path,
      token: body.token,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status as 400 | 500 | 502);
    return c.json(
      { repo: parsed.repo, ref: ref ?? null, path: path ?? null, commit: result.commit, skills: result.skills },
      201,
    );
  });

  // ---------------------------------------------------------------------------
  // POST /v1/skills/sync/github — re-import every distinct GitHub source
  // tracked by this tenant's skills. Body: { token? } (optional, used for all
  // sources — tokens are never stored). Skills present locally but gone from
  // the repo are kept and reported as `orphaned`. New skills appearing in a
  // tracked repo/path are created.
  // ---------------------------------------------------------------------------

  app.post("/sync/github", async (c) => {
    const services = resolveServices(deps.services, c);
    const t = c.get("tenant_id");
    // Same rate limiter as uploads/imports — each source is comparable work
    // to an import.
    const freqCheck = deps.checkUploadFreq ? await deps.checkUploadFreq(t) : null;
    if (freqCheck) return freqCheck;
    const bucket = services.filesBlob ?? null;
    if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

    let token: string | undefined;
    try {
      const body = await c.req.json<{ token?: string }>();
      token = body.token || undefined;
    } catch {
      /* empty body is fine */
    }

    const keys = await kvListAll(services.kv, kvPrefix(t, "skill"));
    const tracked: SkillMeta[] = [];
    for (const k of keys) {
      const data = await services.kv.get(k.name);
      if (!data) continue;
      try {
        const s = JSON.parse(data) as SkillMeta;
        if (s.github_source?.repo) tracked.push(s);
      } catch {
        /* skip unparseable rows */
      }
    }
    if (tracked.length === 0) {
      return c.json({ sources: [], message: "No skills with a GitHub source to sync." });
    }

    const bySource = new Map<string, { repo: string; ref?: string; path?: string; skills: SkillMeta[] }>();
    for (const s of tracked) {
      const g = s.github_source!;
      const key = `${g.repo} ${g.ref ?? ""} ${g.path ?? ""}`;
      const group = bySource.get(key) ?? { repo: g.repo, ref: g.ref, path: g.path, skills: [] };
      group.skills.push(s);
      bySource.set(key, group);
    }

    if (bySource.size > SYNC_MAX_SOURCES) {
      return c.json(
        {
          error: `${bySource.size} distinct GitHub sources tracked; sync handles at most ${SYNC_MAX_SOURCES} per request.`,
        },
        400,
      );
    }

    const sources: Array<Record<string, unknown>> = [];
    for (const group of bySource.values()) {
      const result = await importGitHubSource(services.kv, bucket, t, {
        repo: group.repo,
        ref: group.ref,
        path: group.path,
        token,
      });
      if (!result.ok) {
        sources.push({
          repo: group.repo,
          ref: group.ref ?? null,
          path: group.path ?? null,
          error: result.error,
        });
        continue;
      }
      const importedNames = new Set(result.skills.map((s) => s.name));
      // Orphan-and-keep: tracked locally, no longer in the repo. Reported so
      // the user can prune manually; never auto-deleted.
      const orphaned = group.skills
        .filter((s) => !importedNames.has(s.name))
        .map((s) => ({ skill_id: s.id, name: s.name }));
      sources.push({
        repo: group.repo,
        ref: group.ref ?? null,
        path: group.path ?? null,
        commit: result.commit,
        skills: result.skills,
        orphaned,
      });
    }

    return c.json({ sources });
  });

  return app;
}
