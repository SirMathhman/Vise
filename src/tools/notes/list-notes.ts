import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { NOTES_FOLDER, parseHeader } from "../../core/notes.ts";
import { err, ok, type Result } from "../../core/result.ts";
import { sanitize } from "../../core/tools.ts";
import { resolveInside } from "../files/contain.ts";

interface ListedNote {
  category: string;
  name: string;
  summary: string;
}

// One line per note, as category/name with the summary after it, sorted by category and then name.
// `category` limits the list to one folder. A note whose header cannot be read is still listed, with
// the reason in place of its summary.
export async function listNotes(root: string, category?: string): Promise<Result<string>> {
  const folders = await entries(root, NOTES_FOLDER);
  if (!folders.ok) return folders;
  const notes: ListedNote[] = [];
  for (const folder of folders.value) {
    if (!folder.isDirectory() || (category !== undefined && folder.name !== category)) continue;
    const files = await entries(root, join(NOTES_FOLDER, folder.name));
    if (!files.ok) return files;
    for (const file of files.value) {
      if (file.isFile() && file.name.endsWith(".md")) notes.push(await describe(root, folder.name, file.name));
    }
  }
  if (notes.length === 0) return ok("(no notes)");
  notes.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  return ok(
    notes
      .map((note) => sanitize(`${note.category}/${note.name}${note.summary === "" ? "" : ` - ${note.summary}`}`))
      .join("\n"),
  );
}

// The entries of a folder. A folder that does not exist yet has none.
async function entries(root: string, folder: string): Promise<Result<Dirent[]>> {
  try {
    return ok(await readdir(join(root, folder), { withFileTypes: true }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

async function describe(root: string, category: string, file: string): Promise<ListedNote> {
  const name = file.slice(0, -".md".length);
  const text = await readNote(root, join(NOTES_FOLDER, category, file));
  if (!text.ok) return { category, name, summary: `(${text.error.message})` };
  const header = parseHeader(text.value);
  if (!header.ok) return { category, name, summary: `(${header.error.message})` };
  return { category, name, summary: header.value.summary };
}

// Reads a note through the containment check, so a link out of the working directory is not followed.
async function readNote(root: string, rel: string): Promise<Result<string>> {
  const place = await resolveInside(root, rel);
  if (!place.ok) return place;
  try {
    return ok(await readFile(place.value.realTarget, "utf8"));
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}
