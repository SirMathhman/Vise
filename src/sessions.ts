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
 * The filename (minus extension) is the session name. The fixed
 * crash-recovery snapshot is written as `auto.json`.
 *
 * This module is edge I/O (invariant #2). It is shared by the `SessionSource`
 * interface implementation (`index.ts`) and the `/save` and `/resume`
 * commands' handler in `session.ts`.
 */

/** The fixed filename for the auto-save crash-recovery snapshot. */
export const AUTO_SAVE_NAME = "auto";

/** Path of the sessions directory under the base directory. */
function sessionDir(base: string): string {
  return join(base, "sessions");
}

/** Path of a single session file. */
function sessionPath(base: string, name: string): string {
  return join(sessionDir(base), `${name}.json`);
}

/**
 * Session names must be a single path-safe segment (no traversal).
 * Reuses the same rule as notes and profiles.
 */
function validName(name: string): boolean {
  return (
    name.length > 0 &&
    name !== AUTO_SAVE_NAME &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

/**
 * Serialize a session snapshot to a JSON string.
 */
function serialize(messages: Message[], activeProfile: string | undefined): string {
  const saved: SavedSession = {
    messages,
    activeProfile,
    savedAt: new Date().toISOString(),
  };
  return JSON.stringify(saved, null, 2);
}

/**
 * Write a session snapshot under the fixed auto-save name.
 * Creates the `sessions/` directory if it does not exist.
 */
export function saveAutoSession(
  base: string,
  messages: Message[],
  activeProfile: string | undefined,
): Result<void> {
  const dir = sessionDir(base);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const path = sessionPath(base, AUTO_SAVE_NAME);
  writeFileSync(path, serialize(messages, activeProfile), "utf-8");
  return { ok: true, value: undefined };
}

/**
 * Write a named session snapshot. Fails with a `malformed` error when the
 * name is invalid.
 */
export function saveNamedSession(
  base: string,
  name: string,
  messages: Message[],
  activeProfile: string | undefined,
): Result<void> {
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
  const path = sessionPath(base, name);
  writeFileSync(path, serialize(messages, activeProfile), "utf-8");
  return { ok: true, value: undefined };
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
      activeProfile: typeof raw.activeProfile === "string" ? raw.activeProfile : undefined,
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
    const name = f.slice(0, -".json".length);
    out.push(name);
  }
  return out;
}

/**
 * Delete a named session snapshot by name. Fails with a `malformed` error when
 * the session does not exist. The `auto` snapshot is reserved and cannot be
 * deleted (it is rewritten after every successful turn, so deleting it would
 * be immediately overwritten and could confuse the crash-recovery contract).
 */
export function deleteSession(base: string, name: string): Result<void> {
  if (name === AUTO_SAVE_NAME) {
    const error: ViseError = {
      kind: "malformed",
      body: `session '${name}' is the auto-save snapshot and cannot be deleted`,
    };
    return { ok: false, error };
  }
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
