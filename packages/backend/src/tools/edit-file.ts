import type { Result } from "common";
import { err, ok, parseJson } from "common";
import { z } from "zod";
import type { Approval } from "../chat/approvals";
import { readProjectText } from "../project/project-files";

/**
 * The name the model uses to call the edit-file tool.
 */
export const EDIT_FILE_NAME = "edit_file";

/**
 * The tool the model may call. Each edit waits for the user's approval before it is written.
 */
export const EDIT_FILE_TOOL = {
  type: "function" as const,
  function: {
    name: EDIT_FILE_NAME,
    description:
      "Replace one piece of text in a project file. old_text must appear exactly once in the file. The user approves each edit before it is written. Files that git ignores cannot be edited.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "File path relative to the project root.",
        },
        old_text: {
          type: "string",
          description:
            "The exact text to replace, including whitespace. It must appear exactly once.",
        },
        new_text: {
          type: "string",
          description: "The text to put in its place.",
        },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
};

const EditArgumentsSchema = z.object({
  path: z.string(),
  old_text: z.string().min(1),
  new_text: z.string(),
});

/**
 * Replaces the single occurrence of oldText, or says why it cannot.
 *
 * @param text The file's current text.
 * @param oldText The exact text to replace.
 * @param newText The text to put in its place.
 * @returns The new text, or the reason the replacement cannot be made.
 */
export function replaceOnce(
  text: string,
  oldText: string,
  newText: string,
): Result<string, string> {
  const first = text.indexOf(oldText);
  if (first === -1) {
    return err("old_text was not found in the file.");
  }
  if (text.indexOf(oldText, first + 1) !== -1) {
    return err(
      "old_text appears more than once; include more surrounding text so it is unique.",
    );
  }
  return ok(
    text.slice(0, first) + newText + text.slice(first + oldText.length),
  );
}

// The change as removed lines followed by added lines.
function diffBody(oldText: string, newText: string): string {
  const removed = oldText.split("\n").map((line) => `- ${line}`);
  const added = newText.split("\n").map((line) => `+ ${line}`);
  return [...removed, ...added].join("\n");
}

/**
 * Proposes one edit for approval. Returns the reason it cannot be proposed as text.
 *
 * @param root The project root.
 * @param argumentsJson The model's arguments, as JSON text.
 * @returns The approval card to show, or the reason the edit cannot be proposed.
 */
export async function runEditFile(
  root: string,
  argumentsJson: string,
): Promise<string | Approval> {
  const args = parseJson(EditArgumentsSchema, argumentsJson);
  if (!args.ok) {
    return "The arguments were not valid. Use path, old_text, and new_text.";
  }
  const { path: requested, old_text: oldText, new_text: newText } = args.value;
  const current = await readProjectText(root, requested);
  if (!current.ok) {
    return current.error;
  }
  const planned = replaceOnce(current.value.text, oldText, newText);
  if (!planned.ok) {
    return planned.error;
  }
  return {
    title: `Edit ${requested}`,
    body: diffBody(oldText, newText),
    apply: async () => {
      // The file may have changed while the user decided, so check again before writing.
      const again = await readProjectText(root, requested);
      if (!again.ok) {
        return again.error;
      }
      const next = replaceOnce(again.value.text, oldText, newText);
      if (!next.ok) {
        return next.error;
      }
      await Bun.write(again.value.absolute, next.value);
      return `Edited ${requested}.`;
    },
  };
}
