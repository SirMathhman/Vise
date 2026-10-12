import { join } from "node:path";
import type { Result } from "@vise/core";
import { globalDataDir } from "../../data-dir.ts";
import { AUDIT_MIGRATIONS } from "./audit-schema.ts";
import { openDb, tryDb } from "../open.ts";

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
  const found = tryDb(
    "read the audit log",
    path,
    () =>
      db
        .query("SELECT * FROM audit_sessions WHERE substr(id, 1, ?) = ?")
        .all(ref.length, ref) as { id: string }[],
  );
  if (!found.ok) return found;
  const [session, extra] = found.value;
  if (session === undefined || extra !== undefined) {
    const body =
      session === undefined
        ? `no recorded conversation starts with '${ref}'`
        : `'${ref}' matches more than one conversation; use more characters`;
    return { ok: false, error: { kind: "malformed", body } };
  }
  return tryDb("read the audit log", path, () => {
    const out: Record<string, unknown> = { session };
    for (const table of TABLES) {
      const order = table === "audit_turns" ? "started_at" : "id";
      out[table.slice("audit_".length)] = db
        .query(`SELECT * FROM ${table} WHERE session_id = ? ORDER BY ${order}`)
        .all(session.id);
    }
    return out;
  });
}
