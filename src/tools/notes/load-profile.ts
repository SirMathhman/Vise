import { PROFILE_CATEGORY, bodyOf, notePath, parseHeader, type ProfileLoader } from "../../core/notes.ts";
import { err, ok } from "../../core/result.ts";
import { readNote } from "./read-note.ts";

// The loader for a working directory: reads notes/profile/<name>.md and returns the text below its
// header. A profile that cannot be read, or has no text below its header, is refused.
export function loadProfile(root: string): ProfileLoader {
  return async (name) => {
    const text = await readNote(root, notePath(PROFILE_CATEGORY, name));
    if (!text.ok) return err(new Error(`profile ${name} could not be read: ${text.error.message}`));
    const header = parseHeader(text.value);
    if (!header.ok) return err(new Error(`profile ${name} is not a note: ${header.error.message}`));
    const body = bodyOf(text.value);
    if (body === "") return err(new Error(`profile ${name} is empty`));
    return ok(body);
  };
}
