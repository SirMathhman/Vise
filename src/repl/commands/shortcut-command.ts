import type { ViseError } from "../../core/errors.ts";
import type { NoteSource, WorkflowSource } from "../ports.ts";

/** What `/<name> [input]` means: a workflow to run, a note to send as the message, or a refusal. */
export type Shortcut =
  | { kind: "workflow"; line: string }
  | { kind: "note"; text: string }
  | { kind: "error"; error: ViseError };

/** A note's body as the message: `{{input}}` is replaced by the input, which is appended when the note has no placeholder. */
export function noteMessage(body: string, input: string): string {
  if (body.includes("{{input}}")) return body.replaceAll("{{input}}", input);
  return input === "" ? body : `${body}\n\n${input}`;
}

const refuse = (body: string): Shortcut => ({
  kind: "error",
  error: { kind: "malformed", body },
});

/**
 * Resolve `/<name> [input]` for a name that is not a built-in command. A
 * workflow of that name runs as `/workflow <name> [input]`; a note of that name
 * is sent as the message. A name that is both (or several notes) is refused,
 * because there is no telling which was meant. Undefined when no note or
 * workflow has the name (the line is then an ordinary message).
 */
export async function resolveShortcut(
  notes: NoteSource | undefined,
  workflows: WorkflowSource | undefined,
  line: string,
): Promise<Shortcut | undefined> {
  const match = /^\/([^\s/\\]+)(?:\s+([\s\S]*))?$/.exec(line);
  if (!match?.[1]) return undefined;
  const name = match[1];
  const input = (match[2] ?? "").trim();
  const listed = workflows ? await workflows.listWorkflows() : undefined;
  const isWorkflow = listed?.ok === true && listed.value.some((w) => w.name === name);
  const found = await notes?.findNotes?.(name);
  if (found && !found.ok) return { kind: "error", error: found.error };
  const matching = found?.value ?? [];
  if (matching.length > 1) {
    const where = matching.map((n) => `${n.scope}/${n.category}`).join(", ");
    return refuse(`'/${name}' is ambiguous: notes with that name exist in ${where}`);
  }
  if (isWorkflow && matching.length === 1) {
    return refuse(`'/${name}' is both a note and a workflow; rename one of them`);
  }
  if (isWorkflow) return { kind: "workflow", line: `/workflow ${name} ${input}`.trim() };
  const note = matching[0];
  return note ? { kind: "note", text: noteMessage(note.body, input) } : undefined;
}
