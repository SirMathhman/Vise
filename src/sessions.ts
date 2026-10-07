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
import type { SavedSession } from "./repl/session.ts";

/**
 * Shared session-file I/O for the edge. Sessions are saved snapshots of
 * the conversation, stored one `.json` file per session under `sessions/`.
 * The filename (minus extension) is the session name. Every conversation
 * is auto-saved after each successful turn under a name derived from its
 * first user message (see `session.ts`); there is no separate fixed
 * crash-recovery snapshot.
 *
 * This module is edge I/O (invariant #2). It is shared by the `SessionSource`
 * interface implementation (`index.ts`) and the `/save` and `/resume`
 * commands' handler in `session.ts`.
 */

/** Path of the sessions directory under the base directory. */
function sessionDir(base: string): string {
  return join(base, "sessions");
}

/**
 * Path of a single session file. Names are matched ignoring surrounding
 * whitespace, because older auto-saved files can end in a space (the derived
 * name was cut at a fixed length) while every command and UI trims the name
 * it shows or receives.
 */
function sessionPath(base: string, name: string): string {
  const dir = sessionDir(base);
  const exact = join(dir, `${name}.json`);
  if (existsSync(exact) || !existsSync(dir)) return exact;
  const match = readdirSync(dir).find(
    (f) => f.endsWith(".json") && f.slice(0, -5).trim() === name.trim(),
  );
  return match === undefined ? exact : join(dir, match);
}

/**
 * Session names must be a single path-safe segment (no traversal).
 * Reuses the same rule as notes and profiles.
 */
function validName(name: string): boolean {
  return (
    name.length > 0 &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

/**
 * Serialize a session snapshot to a JSON string.
 */
function serialize(
  messages: Message[],
  activeProfile: string | undefined,
): string {
  const saved: SavedSession = {
    messages,
    activeProfile,
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(saved, null, 2);
}

/**
 * Resolve a name collision: if `name` is already taken, append a numeric
 * suffix (`-2`, `-3`, ...) until the name is free. Returns the name to use.
 */
function resolveName(base: string, name: string): string {
  let candidate = name;
  let counter = 2;
  while (existsSync(sessionPath(base, candidate))) {
    candidate = `${name}-${counter}`;
    counter++;
  }
  return candidate;
}

/**
 * Write a session snapshot under the given name. The initial autosave
 * resolves a collision with a numeric suffix; later autosaves overwrite the
 * previously resolved name. Fails with a `malformed` error when the name is
 * invalid. Creates the `sessions/` directory if it does not exist.
 */
export function saveAutoSession(
  base: string,
  name: string,
  messages: Message[],
  activeProfile: string | undefined,
  overwrite: boolean,
): Result<string> {
  if (!validName(name)) {
    const error: ViseError = {
      kind: "malformed",
      body: `invalid session name '${name}' (no path separators, no dots-only)`,
    };
    return { ok: false, error };
  }
  const dir = sessionDir(base);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalName = overwrite ? name : resolveName(base, name);
  writeFileSync(
    sessionPath(base, finalName),
    serialize(messages, activeProfile),
    "utf-8",
  );
  return { ok: true, value: finalName };
}

/**
 * Write a named session snapshot (the manual `/save <name>` path). Fails
 * with a `malformed` error when the name is invalid. When `name` is already
 * taken, a numeric suffix is appended (e.g. `name-2`) and the chosen name is
 * returned as the result value, so the caller knows which name the snapshot
 * landed under. Creates the `sessions/` directory if it does not exist.
 */
export function saveNamedSession(
  base: string,
  name: string,
  messages: Message[],
  activeProfile: string | undefined,
): Result<string> {
  if (!validName(name)) {
    const error: ViseError = {
      kind: "malformed",
      body: `invalid session name '${name}' (no path separators, no dots-only)`,
    };
    return { ok: false, error };
  }
  const dir = sessionDir(base);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const finalName = resolveName(base, name);
  const path = sessionPath(base, finalName);
  writeFileSync(path, serialize(messages, activeProfile), "utf-8");
  return { ok: true, value: finalName };
}

/**
 * Load a session by name. Fails with a `malformed` error when the session
 * does not exist or the file is not valid JSON.
 */
export function loadSession(base: string, name: string): Result<SavedSession> {
  const path = sessionPath(base, name);
  if (!existsSync(path)) {
    const error: ViseError = {
      kind: "malformed",
      body: `session '${name}' not found. Run '/resume' to see available sessions.`,
    };
    return { ok: false, error };
  }
  const text = readFileSync(path, "utf-8");
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (
      !Array.isArray(raw.messages) ||
      (raw.activeProfile !== undefined && typeof raw.activeProfile !== "string")
    ) {
      const error: ViseError = {
        kind: "malformed",
        body: `session '${name}' is corrupted (missing messages or invalid shape)`,
      };
      return { ok: false, error };
    }
    const saved: SavedSession = {
      messages: raw.messages as Message[],
      activeProfile:
        typeof raw.activeProfile === "string" ? raw.activeProfile : undefined,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : "",
    };
    return { ok: true, value: saved };
  } catch {
    const error: ViseError = {
      kind: "malformed",
      body: `session '${name}' is corrupted (invalid JSON)`,
    };
    return { ok: false, error };
  }
}

/**
 * List all saved session names (without file extension), sorted by name.
 * Returns an empty array when the directory does not exist.
 */
export function listSessions(base: string): string[] {
  const dir = sessionDir(base);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith(".json")) continue;
    const name = f.slice(0, -".json".length).trim();
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * Delete a named session snapshot by name. Fails with a `malformed` error when
 * the session does not exist. Auto-saved sessions are ordinary named
 * snapshots and can be deleted like any other.
 */
export function deleteSession(base: string, name: string): Result<void> {
  const path = sessionPath(base, name);
  if (!existsSync(path)) {
    const error: ViseError = {
      kind: "malformed",
      body: `session '${name}' not found. Run '/resume' to see available sessions.`,
    };
    return { ok: false, error };
  }
  unlinkSync(path);
  return { ok: true, value: undefined };
}
