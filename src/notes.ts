// Note registry and notes intro. Notes are a file convention that unifies
// "memories" (facts, decisions, things to remember) and "skills" (reusable
// how-to instructions) into plain .md files the model and the user read and
// write with the regular file tools. There is no type distinction: a note is
// a fact, a decision, or a how-to the model wants to keep across sessions.
//
// A note lives at .agents/notes/<name>.md. The filename (minus .md) is the
// note's name; a `summary: <one line>` line near the top of the file feeds
// the short index; the rest of the file is the note's full content.
//
// The short index (a `name — summary` line per note) is injected at the
// beginning of the system prompt at startup and rebuilt by compaction. It
// is static for a session: notes created or edited mid-session with the
// regular file tools appear in the index on the next session. The file
// convention itself is documented in AGENTS.md (always in the system prompt
// via composeInstruction), so the intro only lists what notes currently exist.
//
// No mutable state, no fetch, no stdin/stdout. Functions over the filesystem
// (a documented FS exception, invariant 5, like AGENTS.md and .agents/*.md).
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

const NOTES_DIR = path.join(".agents", "notes");

export type Note = {
  name: string;
  summary: string;
  content: string;
};

// Reads .agents/notes/<name>.md from the working directory and returns its
// name, summary, and content. Returns null if the file is missing, not a
// regular file, or unreadable.
export function getNote(name: string): Note | null {
  const filePath = path.resolve(process.cwd(), NOTES_DIR, `${name}.md`);
  if (!existsSync(filePath) || !statSync(filePath).isFile()) return null;
  try {
    const content = readFileSync(filePath, "utf-8");
    return parseNote(name, content);
  } catch {
    return null;
  }
}

// Creates a new note template at .agents/notes/<name>.md. Names are a single
// safe filename component; an existing file is never overwritten.
export function createNote(name: string): string | null {
  if (!/^[a-zA-Z0-9_-][a-zA-Z0-9._-]*$/.test(name)) {
    return "note name must use letters, numbers, dots, hyphens, or underscores";
  }
  const dirPath = path.resolve(process.cwd(), NOTES_DIR);
  const filePath = path.join(dirPath, `${name}.md`);
  try {
    mkdirSync(dirPath, { recursive: true });
    writeFileSync(filePath, "summary: \n\n", { encoding: "utf-8", flag: "wx" });
    return null;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "EEXIST") {
      return `note already exists: ${name}`;
    }
    return `could not create note: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// Returns every note in .agents/notes/ (alphabetical by name), or an empty
// array when the directory is absent or has no .md files.
export function listNotes(): Note[] {
  const dirPath = path.resolve(process.cwd(), NOTES_DIR);
  if (!existsSync(dirPath) || !statSync(dirPath).isDirectory()) return [];
  const notes: Note[] = [];
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".md")) continue;
    const name = entry.name.replace(/\.md$/, "");
    if (name.length === 0) continue;
    try {
      const content = readFileSync(path.join(dirPath, entry.name), "utf-8");
      const parsed = parseNote(name, content);
      if (parsed) notes.push(parsed);
    } catch {
      // unreadable file: skip
    }
  }
  notes.sort((a, b) => a.name.localeCompare(b.name));
  return notes;
}

// Parses note file content into name + summary + content. A line beginning
// with "summary:" (case-insensitive) sets the summary; that line is removed
// from the content. The name always comes from the filename, not the file.
function parseNote(name: string, raw: string): Note | null {
  const lines = raw.split("\n");
  let summary = "";
  const contentLines: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.toLowerCase().startsWith("summary:") && !summary) {
      const value = trimmed.slice("summary:".length).trim();
      summary = value;
    } else {
      contentLines.push(line);
    }
  }
  const content = contentLines.join("\n").trim();
  return { name, summary, content };
}

// Builds the short notes index block injected at the beginning of the system
// prompt. With no notes, returns null (nothing to inject). With notes,
// returns a "Current notes:" header plus one `name — summary` line per note
// so the model knows what exists and where to read the full content from.
// The file convention itself is documented in AGENTS.md (always in the
// system prompt via composeInstruction), so this only lists the current
// notes rather than re-explaining what notes are.
export function buildNotesIntro(): string | null {
  const notes = listNotes();
  if (notes.length === 0) return null;
  const lines = ["Current notes:"];
  for (const note of notes) {
    lines.push(`  ${note.name} — ${note.summary || "(no summary)"}`);
  }
  return lines.join("\n");
}

// The intro block, computed once at module load (like AGENTS.md) and reused
// for the rest of the session, so edits to .agents/notes/ mid-session are not
// picked up. null when there are no notes at startup.
const NOTES_INTRO = buildNotesIntro();

// Prepends the short notes index to a profile's system instruction so the
// notes list sits at the beginning of the system prompt. Returns the
// instruction unchanged when there are no notes. Used to seed the initial
// system message (loop.ts), to append a profile's system message on switch,
// and to rebuild the instruction after compaction (compact.ts).
export function withNotesIntro(instruction: string): string {
  if (NOTES_INTRO === null) return instruction;
  return `${NOTES_INTRO}\n\n${instruction}`;
}

// Refreshes a generated note-index prefix from a persisted system message.
// Messages without that prefix are returned unchanged.
export function refreshNotesIntro(instruction: string): string {
  if (!instruction.startsWith("Current notes:\n")) return instruction;
  const separator = instruction.indexOf("\n\n");
  const body = separator < 0 ? "" : instruction.slice(separator + 2);
  return withNotesIntro(body);
}
