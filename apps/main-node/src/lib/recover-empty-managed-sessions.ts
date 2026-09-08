import type { SqlClient } from "@open-managed-agents/sql-client";

/** Older Node runtimes created empty sessions as running without a turn to
 * finish. Restore only those empty records; a concurrent accepted message
 * changes the revision and prevents this update. */
export async function recoverEmptyManagedSessions(sql: SqlClient): Promise<number> {
  const rows = await sql.prepare(`
    SELECT id, workspace_id, document, revision FROM managed_sessions s
    WHERE status = 'running'
      AND NOT EXISTS (SELECT 1 FROM managed_session_events e WHERE e.workspace_id = s.workspace_id AND e.session_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM managed_session_initial_events i WHERE i.workspace_id = s.workspace_id AND i.session_id = s.id)
  `).all<{ id: string; workspace_id: string; document: string; revision: number }>();
  let recovered = 0;
  for (const row of rows.results ?? []) {
    const session = JSON.parse(row.document);
    const result = await sql.prepare(`
      UPDATE managed_sessions SET status = 'idle', document = ?, revision = revision + 1
      WHERE workspace_id = ? AND id = ? AND revision = ? AND status = 'running'
        AND NOT EXISTS (SELECT 1 FROM managed_session_events e WHERE e.workspace_id = managed_sessions.workspace_id AND e.session_id = managed_sessions.id)
        AND NOT EXISTS (SELECT 1 FROM managed_session_initial_events i WHERE i.workspace_id = managed_sessions.workspace_id AND i.session_id = managed_sessions.id)
    `).bind(JSON.stringify({ ...session, status: "idle" }), row.workspace_id, row.id, row.revision).run();
    recovered += result.meta.changes;
  }
  return recovered;
}
