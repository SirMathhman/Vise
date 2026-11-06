import { err, ok, type Result } from "./result.ts";

// Notes live in notes/<category>/<name>.md under the working directory. A note is identified by
// its category and name, which are also its folder and file names. A profile is a note in the
// profile category.
export const NOTES_FOLDER = "notes";
export const PROFILE_CATEGORY = "profile";
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const USAGE = "usage: /note new <category> <name> | /note list [category]";
const PROFILE_USAGE = "usage: /profile [name | default]";

// The points at which a hook runs: before and after a session, and before and after a turn.
export const HOOK_POINTS = ["sessionStart", "sessionEnd", "turnStart", "turnEnd"] as const;
export type HookPoint = (typeof HOOK_POINTS)[number];

// A command a profile runs at one point, from a `<point>: <command>` line of its header.
export interface ProfileHook {
  point: HookPoint;
  command: string;
}

export interface NoteHeader {
  name: string;
  category: string;
  summary: string;
  // The tools a profile allows, from its `tools:` line. Absent when the line is absent.
  tools?: string[];
  // The hooks a profile adds, one per `<point>: <command>` line. Absent when there are none.
  hooks?: ProfileHook[];
}

function isHookPoint(key: string): key is HookPoint {
  return (HOOK_POINTS as readonly string[]).includes(key);
}

export interface NewNoteCommand {
  kind: "new";
  category: string;
  name: string;
}

export interface ListNotesCommand {
  kind: "list";
  category?: string;
}

export type NoteCommand = NewNoteCommand | ListNotesCommand;

// Shows the text to print for a /note command. The REPL calls it with the words after /note.
export type NoteRunner = (words: string[]) => Promise<string>;

// Reads a profile's text, without its header. Refuses a profile that does not exist or is empty.
export type ProfileLoader = (name: string) => Promise<Result<string>>;

export interface UseProfileCommand {
  kind: "use";
  name: string;
}

export interface ClearProfileCommand {
  kind: "clear";
}

export interface ShowProfileCommand {
  kind: "show";
}

export type ProfileCommand = UseProfileCommand | ClearProfileCommand | ShowProfileCommand;

// A category or name is one folder or file name: letters, digits, - and _. The message does not
// repeat the value, so a refused name cannot put control characters on the terminal.
export function checkName(value: string, what: string): Result<string> {
  if (!NAME_PATTERN.test(value)) return err(new Error(`${what} may contain only letters, digits, - and _`));
  return ok(value);
}

export function notePath(category: string, name: string): string {
  return `${NOTES_FOLDER}/${category}/${name}.md`;
}

// The text of a new note: a header with its name, category, and an empty summary, then a heading.
export function scaffold(category: string, name: string): string {
  return `---\nname: ${name}\ncategory: ${category}\nsummary:\n---\n\n# ${name}\n\n`;
}

// Notes may be edited on Windows, so CRLF line endings are read the same as LF.
function linesOf(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

// The index of the line that closes the header, or -1 when there is none.
function headerEnd(lines: string[]): number {
  return lines.findIndex((line, index) => index > 0 && line.trim() === "---");
}

// Reads the header of a note: the `key: value` lines between its first two `---` lines.
export function parseHeader(text: string): Result<NoteHeader> {
  const lines = linesOf(text);
  if (lines[0]?.trim() !== "---") return err(new Error("the note has no header"));
  const end = headerEnd(lines);
  if (end < 0) return err(new Error("the note header is not closed"));
  const values = new Map<string, string>();
  const hooks: ProfileHook[] = [];
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    values.set(key, value);
    if (isHookPoint(key) && value !== "") hooks.push({ point: key, command: value });
  }
  const name = values.get("name");
  const category = values.get("category");
  if (!name || !category) return err(new Error("the note header needs a name and a category"));
  const tools = values.get("tools");
  const header: NoteHeader = { name, category, summary: values.get("summary") ?? "" };
  if (tools !== undefined) header.tools = tools.split(",").map((tool) => tool.trim()).filter((tool) => tool !== "");
  if (hooks.length > 0) header.hooks = hooks;
  return ok(header);
}

// The text below the header, trimmed. Empty when the note has no closed header.
export function bodyOf(text: string): string {
  const lines = linesOf(text);
  const end = headerEnd(lines);
  if (end < 0) return "";
  return lines.slice(end + 1).join("\n").trim();
}

// Reads the words after /note. Anything else is refused with the usage line.
export function parseNoteCommand(words: string[]): Result<NoteCommand> {
  const [action, first, second] = words;
  if (action === "new" && first !== undefined && second !== undefined && words.length === 3) {
    const category = checkName(first, "category");
    if (!category.ok) return category;
    const name = checkName(second, "name");
    if (!name.ok) return name;
    return ok({ kind: "new", category: category.value, name: name.value });
  }
  if (action === "list" && words.length <= 2) {
    if (first === undefined) return ok({ kind: "list" });
    const category = checkName(first, "category");
    if (!category.ok) return category;
    return ok({ kind: "list", category: category.value });
  }
  return err(new Error(USAGE));
}

// Reads the words after /profile: nothing shows the active profile, `default` turns profiles off,
// and a name switches to that profile.
export function parseProfileCommand(words: string[]): Result<ProfileCommand> {
  const [first] = words;
  if (words.length === 0) return ok({ kind: "show" });
  if (words.length !== 1 || first === undefined) return err(new Error(PROFILE_USAGE));
  if (first === "default") return ok({ kind: "clear" });
  const name = checkName(first, "name");
  if (!name.ok) return name;
  return ok({ kind: "use", name: name.value });
}
