import { unzipSync } from "fflate";

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

/**
 * Keep the product's convenient zip picker while emitting the Managed Skills
 * API's `files[]` shape. File names retain their archive-relative paths so the
 * server can validate the required top-level directory and SKILL.md.
 */
export async function extractManagedSkillFiles(zip: File): Promise<File[]> {
  const archive = unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const files = Object.entries(archive)
    .filter(([path]) => path !== "" && !path.endsWith("/"))
    .map(([path, bytes]) => new File([ownedArrayBuffer(bytes)], path));

  if (files.length === 0) {
    throw new Error("The skill archive does not contain any files");
  }
  return files;
}

export function previewManagedSkillFiles(zip: ArrayBuffer): Array<{ filename: string; content: string; encoding: "utf8" | "base64" }> {
  return Object.entries(unzipSync(new Uint8Array(zip)))
    .filter(([path]) => path !== "" && !path.endsWith("/"))
    .map(([filename, bytes]) => {
      try {
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (content.includes("\0")) throw new Error("Binary file");
        return { filename, content, encoding: "utf8" as const };
      } catch {
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return { filename, content: btoa(binary), encoding: "base64" as const };
      }
    });
}
