import { notePath, scaffold } from "../../core/notes.ts";
import type { Result } from "../../core/messages.ts";
import { createFile } from "../files/create-file.ts";

// Creates notes/<category>/<name>.md with its header. The category and name must already have
// passed checkName, which the callers do when they read the arguments. An existing note is never
// overwritten; createFile refuses it.
export function createNote(
  root: string,
  category: string,
  name: string,
): Promise<Result<string>> {
  return createFile(root, notePath(category, name), scaffold(category, name));
}
