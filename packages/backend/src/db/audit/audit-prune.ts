import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { config } from "../../config.ts";
import { globalDataDir } from "../../data-dir.ts";
import { AUDIT_MIGRATIONS } from "./audit-schema.ts";
import { openDb, tryDb } from "../open.ts";

/** The tables keyed by `session_id`, in the order their rows are removed. */
export const BY_SESSION = [
  "audit_fts",
  "audit_events",
  "audit_tool_calls",
  "audit_model_calls",
  "audit_messages",
  "audit_turns",
];

/**
 * Delete every conversation whose last sign of life is before `cutoff`, with
 * everything recorded in it, in one transaction: a transcript is removed whole
 * or not at all. A conversation's last sign of life is its end, or, when it
 * never ended (still open, or the program died), its newest message, so one
 * that is still being used is never taken. The file is not shrunk (that
 * needs a VACUUM, which stalls everything); freed pages are reused. Returns
 * how many conversations went.
 */
export function pruneAudit(db: Database, cutoff: string): number {
  const old = `SELECT id FROM audit_sessions s WHERE COALESCE(
      ended_at,
      (SELECT MAX(ts) FROM audit_messages m WHERE m.session_id = s.id),
      started_at) < ?`;
  return db.transaction(() => {
    for (const table of BY_SESSION) {
      db.query(`DELETE FROM ${table} WHERE session_id IN (${old})`).run(cutoff);
    }
    return db.query(`DELETE FROM audit_sessions WHERE id IN (${old})`).run(cutoff).changes;
  })();
}

/** Paths already pruned in this run. */
const pruned = new Set<string>();

/**
 * Apply `VISE_AUDIT_RETENTION_DAYS`: once per run, before any conversation
 * starts recording (never from the write path of a turn). A failure is
 * returned, not thrown, and the next call tries again.
 */
export function pruneAuditLog(path: string = join(globalDataDir, "audit.db")): void {
  if (pruned.has(path) || config.auditRetentionDays <= 0) return;
  const opened = openDb(path, AUDIT_MIGRATIONS);
  if (!opened.ok) return;
  const cutoff = new Date(Date.now() - config.auditRetentionDays * 86_400_000);
  const done = tryDb("prune the audit log", path, () =>
    pruneAudit(opened.value, cutoff.toISOString()),
  );
  if (done.ok) pruned.add(path);
}
