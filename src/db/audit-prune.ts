import type { Database } from "bun:sqlite";

/** The tables keyed by `session_id`, in the order their rows are removed. */
const BY_SESSION = [
  "audit_fts",
  "audit_events",
  "audit_tool_calls",
  "audit_model_calls",
  "audit_messages",
  "audit_turns",
];

/**
 * Delete every conversation that ended (or, if it never did, started) before
 * `cutoff`, with everything recorded in it, in one transaction: a transcript
 * is removed whole or not at all. Returns how many conversations went.
 */
export function pruneAudit(db: Database, cutoff: string): number {
  const old =
    "SELECT id FROM audit_sessions WHERE COALESCE(ended_at, started_at) < ?";
  const removed = db.transaction(() => {
    for (const table of BY_SESSION) {
      db.query(`DELETE FROM ${table} WHERE session_id IN (${old})`).run(cutoff);
    }
    return db
      .query("DELETE FROM audit_sessions WHERE id IN (" + old + ")")
      .run(cutoff).changes;
  })();
  if (removed > 0) db.exec("VACUUM"); // otherwise the file never shrinks
  return removed;
}
