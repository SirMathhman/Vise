import { join } from "node:path";
import type { Result } from "../core/errors.ts";
import { globalDataDir } from "../data-dir.ts";
import { AUDIT_MIGRATIONS } from "./audit-schema.ts";
import { openDb, tryDb } from "./open.ts";

const TABLES = [
  "audit_turns",
  "audit_messages",
  "audit_model_calls",
  "audit_tool_calls",
  "audit_events",
];

/**
 * Everything recorded for one conversation (an id or the start of one), as
 * plain data ready for `JSON.stringify`: the conversation's row, then each
 * table's rows in the order they were written.
 */
export function exportAudit(
  ref: string,
  path: string = join(globalDataDir, "audit.db"),
): Result<Record<string, unknown>> {
  const opened = openDb(path, AUDIT_MIGRATIONS);
  if (!opened.ok) return opened;
  const db = opened.value;
  return tryDb("read the audit log", path, () => {
    const found = db
      .query("SELECT * FROM audit_sessions WHERE substr(id, 1, ?) = ?")
      .all(ref.length, ref) as { id: string }[];
    if (found.length !== 1 || found[0] === undefined) {
      throw new Error(
        found.length === 0
          ? `no recorded conversation starts with '${ref}'`
          : `'${ref}' matches ${found.length} conversations; use more characters`,
      );
    }
    const session = found[0];
    const out: Record<string, unknown> = { session };
    for (const table of TABLES) {
      out[table.slice("audit_".length)] = db
        .query(
          `SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${table === "audit_turns" ? "started_at" : "id"}`,
        )
        .all(session.id);
    }
    return out;
  });
}
