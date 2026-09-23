// Session persistence: saves and loads the conversation state so a
// restarted REPL can resume where it left off.
//
// The session file (.vise/session.json) holds the full message history,
// the active profile name, and the tools-enabled flag. On startup, loop.ts
// attempts to load the session and seed the conversation from it; when the
// file is missing or corrupt, a fresh conversation starts instead.
//
// Saving happens after every turn (command or user message), so the file on
// disk always reflects the most recent conversation. Writes are plain
// writeFileSync (matching persist.ts); a failure is logged to stderr but
// never thrown, so a disk error can't crash the REPL.
//
// Documented FS exception (invariant 5): like the hook system and the vector
// index, this module reads and writes the filesystem outside the tools and
// hook layers — at turn boundaries and during /save, /load, /sessions
// (including its delete and rename subcommands), and /new command handling —
// but never during a tool call.
// No fetch, no stdin/stdout.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "./llm/types.ts";
import { refreshNotesIntro, withNotesIntro } from "./notes.ts";
import { BUILTIN_AGENT, getProfile } from "./profiles.ts";

export type SessionState = {
  messages: ChatMessage[];
  activeProfile: string;
  toolsEnabled: boolean;
  // The /think level name; absent in sessions saved before levels existed
  // (and in newConversation results, so /new keeps the current level).
  reasoningLevel?: string;
};

// Reads the optional reasoningLevel field from a parsed session file.
function parseReasoningLevel(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

const SESSION_DIR = ".vise";
const SESSIONS_DIR = "sessions";
const SESSION_FILE = "session.json";

function sessionPath(): string {
  return path.resolve(process.cwd(), SESSION_DIR, SESSION_FILE);
}

function namedSessionsDir(): string {
  return path.resolve(process.cwd(), SESSION_DIR, SESSIONS_DIR);
}

function namedSessionPath(name: string): string {
  return path.resolve(namedSessionsDir(), `${name}.json`);
}

// Validates a session name for use as a filename. Only allows alphanumerics,
// dots, hyphens, and underscores — no path separators or control characters.
function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9._-]+$/.test(name);
}

// Refreshes generated note-index prefixes on restored system messages while
// leaving conversation content and all non-index system messages untouched.
function refreshRestoredMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (message.role !== "system" || typeof message.content !== "string") {
      return message;
    }
    const content = refreshNotesIntro(message.content);
    return content === message.content ? message : { ...message, content };
  });
}

// Loads the saved session from disk. Returns null when the file is missing
// or the JSON is corrupt or has the wrong shape, so the caller can fall back
// to a fresh conversation.
export function loadSession(): SessionState | null {
  const file = sessionPath();
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !Array.isArray(parsed.messages) ||
      typeof parsed.activeProfile !== "string" ||
      typeof parsed.toolsEnabled !== "boolean"
    )
      return null;
    return {
      messages: refreshRestoredMessages(parsed.messages as ChatMessage[]),
      activeProfile: parsed.activeProfile,
      toolsEnabled: parsed.toolsEnabled,
      reasoningLevel: parseReasoningLevel(parsed.reasoningLevel),
    };
  } catch {
    return null;
  }
}

// Saves the session state to disk. Creates the .vise directory if needed.
// Failures are logged to stderr but never thrown.
export function saveSession(state: SessionState): void {
  const dir = path.resolve(process.cwd(), SESSION_DIR);
  const file = sessionPath();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    process.stderr.write(
      `[session] ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

// Saves the conversation state under a named session file at
// .vise/sessions/<name>.json. Creates the directory if needed. Returns null
// on success, or an error message on failure.
export function saveNamedSession(
  name: string,
  state: SessionState,
): string | null {
  if (!isValidName(name)) return `invalid session name: ${name}`;
  const dir = namedSessionsDir();
  const file = namedSessionPath(name);
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(state, null, 2), "utf-8");
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Loads a named session from .vise/sessions/<name>.json. Returns null when
// the file is missing or the JSON is corrupt or has the wrong shape.
export function loadNamedSession(name: string): SessionState | null {
  if (!isValidName(name)) return null;
  const file = namedSessionPath(name);
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (
      !Array.isArray(parsed.messages) ||
      typeof parsed.activeProfile !== "string" ||
      typeof parsed.toolsEnabled !== "boolean"
    )
      return null;
    return {
      messages: refreshRestoredMessages(parsed.messages as ChatMessage[]),
      activeProfile: parsed.activeProfile,
      toolsEnabled: parsed.toolsEnabled,
      reasoningLevel: parseReasoningLevel(parsed.reasoningLevel),
    };
  } catch {
    return null;
  }
}

// Deletes a named session file. Returns null on success, or an error
// message if the name is invalid or no such session exists.
export function deleteNamedSession(name: string): string | null {
  if (!isValidName(name)) return `invalid session name: ${name}`;
  const file = namedSessionPath(name);
  if (!existsSync(file)) return `no such session: ${name}`;
  try {
    unlinkSync(file);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Renames a named session file. Returns null on success, or an error
// message if either name is invalid, the source is missing, or the
// destination already exists — a rename never overwrites; delete the
// destination first if that's the intent.
export function renameNamedSession(
  oldName: string,
  newName: string,
): string | null {
  if (!isValidName(oldName)) return `invalid session name: ${oldName}`;
  if (!isValidName(newName)) return `invalid session name: ${newName}`;
  const oldFile = namedSessionPath(oldName);
  const newFile = namedSessionPath(newName);
  if (!existsSync(oldFile)) return `no such session: ${oldName}`;
  if (existsSync(newFile)) return `session already exists: ${newName}`;
  try {
    renameSync(oldFile, newFile);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

// Lists all saved session names (without the .json extension), sorted
// alphabetically. Returns an empty array when the directory doesn't exist.
export function listNamedSessions(): string[] {
  const dir = namedSessionsDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

// Creates a fresh conversation state seeded with the active profile's
// instruction. Used by /new to start over.
export function newConversation(
  activeProfile: string,
  toolsEnabled: boolean,
): SessionState {
  const profile = getProfile(activeProfile) ?? BUILTIN_AGENT;
  return {
    messages: [
      { role: "system", content: withNotesIntro(profile.instruction) },
    ],
    activeProfile,
    toolsEnabled,
  };
}
