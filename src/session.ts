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
// hook layers — at turn boundaries and during /save, /load, /sessions, and
// /new command handling — but never during a tool call.
// No fetch, no stdin/stdout.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
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
};

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
    };
  } catch {
    return null;
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
