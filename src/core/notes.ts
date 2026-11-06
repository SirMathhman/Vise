import { err, ok, type Result } from "./result.ts";

// Notes live in notes/<category>/<name>.md under the working directory. A note is identified by
// its category and name, which are also its folder and file names.
export const NOTES_FOLDER = "notes";
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const USAGE = "usage: /note new <category> <name> | /note list [category]";

export interface NoteHeader {
  name: string;
  category: string;
  summary: string;
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

// A category or name is one folder or file name. The message does not repeat the value, so a
// refused name cannot put control characters on the terminal.
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

// Reads the header of a note: the `key: value` lines between its first two `---` lines.
// CRLF line endings are accepted, since notes are edited on Windows too.
export function parseHeader(text: string): Result<NoteHeader> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return err(new Error("the note has no header"));
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return err(new Error("the note header is not closed"));
  const values = new Map<string, string>();
  for (const line of lines.slice(1, end)) {
    const colon = line.indexOf(":");
    if (colon > 0) values.set(line.slice(0, colon).trim(), line.slice(colon + 1).trim());
  }
  const name = values.get("name");
  const category = values.get("category");
  if (!name || !category) return err(new Error("the note header needs a name and a category"));
  return ok({ name, category, summary: values.get("summary") ?? "" });
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
