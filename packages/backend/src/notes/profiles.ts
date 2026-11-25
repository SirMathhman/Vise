import type { Result } from "common";
import { PROFILE_CATEGORY, err, ok } from "common";
import { describeNoteError, getNote } from "./notes-store";

/**
 * The instructions of a profile: the content of a note whose category is the profile category.
 *
 * @param id The id of the profile note.
 * @returns The profile's instructions, or the reason the note cannot be used as a profile.
 */
export async function profileInstructions(
  id: string,
): Promise<Result<string, string>> {
  const note = await getNote(id);
  if (!note.ok) {
    return err(describeNoteError(note.error));
  }
  if (note.value.category !== PROFILE_CATEGORY) {
    return err(`The note "${note.value.name}" is not a profile.`);
  }
  return ok(note.value.content);
}
