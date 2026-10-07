import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Message, Result, ViseError } from "./core/errors.ts";
import type { SavedSession, SessionEntry } from "./repl/ports.ts";

/**
 * Shared session-file I/O for the edge. A session is a saved snapshot of the
 * conversation, stored one `.json` file per session under `sessions/`. The
 * file is named by a generated id (a uuid), never by anything the user typed:
 * the human-readable name is a field inside the file, so odd characters,
 * trailing spaces or duplicate names can never break a lookup. Every
 * conversation is auto-saved after each successful turn under its id.
 *
 * This module is edge I/O (invariant #2). It is shared by the `SessionSource`
 * implementation in `edge-sources.ts` and the session commands.
 */

/** Path of the sessions directory under the base directory. */
function sessionDir(base: string): string {
  return join(base, "sessions");
}

/** Session ids are uuids; anything else is not a path-safe file stem. */
const ID_PATTERN = /^[0-9a-f-]{1,36}$/;

function failure(body: string): { ok: false; error: ViseError } {
  return { ok: false, error: { kind: "malformed", body } };
}

/** The ids of every saved session file. */
function savedIds(base: string): string[] {
  const dir = sessionDir(base);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length));
}

/**
 * Resolve a user-supplied reference to a full session id. A reference is an
 * id or the leading characters of one (like a short git hash); it must match
 * exactly one session.
 */
function resolveId(base: string, ref: string): Result<string> {
  const wanted = ref.trim().toLowerCase();
  if (!ID_PATTERN.test(wanted)) {
    return failure(
      `'${ref}' is not a session id. Run '/resume' to see available sessions.`,
    );
  }
  const ids = savedIds(base);
  if (ids.includes(wanted)) return { ok: true, value: wanted };
  const matches = ids.filter((id) => id.startsWith(wanted));
  if (matches.length === 1 && matches[0] !== undefined) {
    return { ok: true, value: matches[0] };
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
 * error when the name is blank. Creates `sessions/` if it does not exist.
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
  const dir = sessionDir(base);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalId = id ?? crypto.randomUUID();
  const saved = {
    name: trimmed,
    messages,
    activeProfile,
    savedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(dir, `${finalId}.json`),
    JSON.stringify(saved, null, 2),
    "utf-8",
  );
  return { ok: true, value: finalId };
}

/**
 * Load a session by id (or unique id prefix). Fails with a `malformed` error
 * when the session does not exist or the file is not valid.
 */
export function loadSession(base: string, ref: string): Result<SavedSession> {
  const resolved = resolveId(base, ref);
  if (!resolved.ok) return resolved;
  const id = resolved.value;
  try {
    const raw = JSON.parse(
      readFileSync(join(sessionDir(base), `${id}.json`), "utf-8"),
    ) as Record<string, unknown>;
    if (
      !Array.isArray(raw.messages) ||
      (raw.activeProfile !== undefined && typeof raw.activeProfile !== "string")
    ) {
      return failure(
        `session '${id}' is corrupted (missing messages or invalid shape)`,
      );
    }
    return {
      ok: true,
      value: {
        id,
        name: typeof raw.name === "string" ? raw.name : id,
        messages: raw.messages as Message[],
        activeProfile:
          typeof raw.activeProfile === "string" ? raw.activeProfile : undefined,
        savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
      },
    };
  } catch {
    return failure(`session '${id}' is corrupted (invalid JSON)`);
  }
}

/**
 * List every saved session (id and display name), sorted by name then id.
 * Returns an empty array when the directory does not exist; unreadable files
 * are listed under their id so they can still be deleted.
 */
export function listSessions(base: string): SessionEntry[] {
  const entries: SessionEntry[] = [];
  for (const id of savedIds(base)) {
    let name = id;
    try {
      const raw = JSON.parse(
        readFileSync(join(sessionDir(base), `${id}.json`), "utf-8"),
      ) as Record<string, unknown>;
      if (typeof raw.name === "string") name = raw.name;
    } catch {
      // keep the id as the display name
    }
    entries.push({ id, name });
  }
  return entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
  );
}

/**
 * Delete a session by id (or unique id prefix) and return the full id. Fails
 * with a `malformed` error when the session does not exist.
 */
export function deleteSession(base: string, ref: string): Result<string> {
  const resolved = resolveId(base, ref);
  if (!resolved.ok) return resolved;
  unlinkSync(join(sessionDir(base), `${resolved.value}.json`));
  return resolved;
}
