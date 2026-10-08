import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Message, Result, ViseError } from "./core/errors.ts";
import type { SavedSession, SessionEntry } from "./repl/ports.ts";
import { importLegacySessions } from "./db/import-json.ts";
import { openDb } from "./db/open.ts";
import { SESSION_MIGRATIONS } from "./db/session-schema.ts";
import { readMessages, writeSession } from "./db/session-write.ts";

/**
 * Shared session I/O for the edge. A session is a saved snapshot of the
 * conversation, stored in the project's SQLite database (`<base>/vise.db`).
 * It is keyed by a generated id (a uuid), never by anything the user typed:
 * the human-readable name is a column, so odd characters, trailing spaces or
 * duplicate names can never break a lookup. Every conversation is auto-saved
 * after each successful turn under its id, in one transaction.
 *
 * This module is edge I/O (invariant #2). It is shared by the `SessionSource`
 * implementation in `edge-sources.ts` and the web resume path.
 */

/** Session ids are uuids; anything else is not a valid reference. */
const ID_PATTERN = /^[0-9a-f-]{1,36}$/;

/** Bases whose old JSON sessions have already been imported by this process. */
const imported = new Set<string>();

/** The session database under `base`, importing old `.json` sessions on first use. */
function sessionDb(base: string): Database {
  const db = openDb(join(base, "vise.db"), SESSION_MIGRATIONS);
  if (!imported.has(base)) {
    imported.add(base);
    importLegacySessions(db, base);
  }
  return db;
}

function failure(body: string): { ok: false; error: ViseError } {
  return { ok: false, error: { kind: "malformed", body } };
}

/**
 * Resolve a user-supplied reference to a full session id. A reference is an
 * id or the leading characters of one (like a short git hash); it must match
 * exactly one session.
 */
function resolveId(db: Database, ref: string): Result<string> {
  const wanted = ref.trim().toLowerCase();
  if (!ID_PATTERN.test(wanted)) {
    return failure(
      `'${ref}' is not a session id. Run '/resume' to see available sessions.`,
    );
  }
  const exact = db.query("SELECT id FROM sessions WHERE id = ?").get(wanted);
  if (exact) return { ok: true, value: wanted };
  const matches = db
    .query("SELECT id FROM sessions WHERE substr(id, 1, ?) = ? LIMIT 2")
    .all(wanted.length, wanted) as { id: string }[];
  if (matches.length === 1 && matches[0] !== undefined) {
    return { ok: true, value: matches[0].id };
  }
  if (matches.length > 1) {
    return failure(`session id '${ref}' is ambiguous; use more characters.`);
  }
  return failure(
    `session '${ref}' not found. Run '/resume' to see available sessions.`,
  );
}

/**
 * Write a session snapshot. With no `id` a new session is created under a
 * fresh uuid; with an `id` that session is overwritten (the auto-save and
 * `/save <name>` rename paths). Returns the id. Fails with a `malformed`
 * error when the name is blank.
 */
export function saveSession(
  base: string,
  id: string | undefined,
  name: string,
  messages: Message[],
  activeProfile: string | undefined,
): Result<string> {
  const trimmed = name.trim();
  if (trimmed === "") return failure("a session name cannot be blank");
  if (id !== undefined && !ID_PATTERN.test(id)) {
    return failure(`invalid session id '${id}'`);
  }
  const finalId = id ?? crypto.randomUUID();
  writeSession(sessionDb(base), finalId, trimmed, messages, activeProfile);
  return { ok: true, value: finalId };
}

interface SessionRow {
  id: string;
  name: string;
  active_profile: string | null;
  updated_at: string;
}

/**
 * Load a session by id (or unique id prefix). Fails with a `malformed` error
 * when the session does not exist.
 */
export function loadSession(base: string, ref: string): Result<SavedSession> {
  const db = sessionDb(base);
  const resolved = resolveId(db, ref);
  if (!resolved.ok) return resolved;
  const row = db
    .query(
      "SELECT id, name, active_profile, updated_at FROM sessions WHERE id = ?",
    )
    .get(resolved.value) as SessionRow | null;
  if (!row) return failure(`session '${ref}' not found.`);
  return {
    ok: true,
    value: {
      id: row.id,
      name: row.name,
      messages: readMessages(db, row.id),
      activeProfile: row.active_profile ?? undefined,
      savedAt: row.updated_at,
    },
  };
}

/** The id of the session saved most recently, if there is one. */
export function latestSessionId(base: string): string | undefined {
  const row = sessionDb(base)
    .query("SELECT id FROM sessions ORDER BY updated_at DESC, id LIMIT 1")
    .get() as { id: string } | null;
  return row?.id;
}

/** List every saved session (id and display name), sorted by name then id. */
export function listSessions(base: string): SessionEntry[] {
  const rows = sessionDb(base)
    .query("SELECT id, name FROM sessions")
    .all() as SessionEntry[];
  return rows.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/**
 * Delete a session by id (or unique id prefix) and return the full id. Fails
 * with a `malformed` error when the session does not exist.
 */
export function deleteSession(base: string, ref: string): Result<string> {
  const db = sessionDb(base);
  const resolved = resolveId(db, ref);
  if (!resolved.ok) return resolved;
  db.transaction(() => {
    db.query("DELETE FROM message_fts WHERE session_id = ?").run(resolved.value);
    db.query("DELETE FROM sessions WHERE id = ?").run(resolved.value);
  })();
  return resolved;
}
