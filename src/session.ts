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
// hook layers — but only at turn boundaries, never during a tool call.
// No fetch, no stdin/stdout.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { ChatMessage } from "./llm/types.ts";

export type SessionState = {
  messages: ChatMessage[];
  activeProfile: string;
  toolsEnabled: boolean;
};

const SESSION_DIR = ".vise";
const SESSION_FILE = "session.json";

function sessionPath(): string {
  return path.resolve(process.cwd(), SESSION_DIR, SESSION_FILE);
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
      messages: parsed.messages as ChatMessage[],
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
