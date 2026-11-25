import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NoteSchema, parseJson } from "common";
import { z } from "zod";
import {
  runDeleteNote,
  runListNotes,
  runReadNote,
  runSaveNote,
} from "../../src/notes/notes-tools";

const SummarySchema = NoteSchema.omit({ content: true });

// Reads a tool's JSON reply through a zod schema, failing the test when it does not match.
function replyAs<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  const parsed = parseJson(schema, text);
  if (!parsed.ok) {
    throw new Error(`Unexpected reply: ${text}`);
  }
  return parsed.value;
}

describe("note tools", () => {
  beforeEach(() => {
    process.env.VISE_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), "vise-notes-"),
    );
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("save_note creates a note that list_notes shows without content and read_note returns in full", async () => {
    const saved = replyAs(
      NoteSchema,
      await runSaveNote(
        JSON.stringify({
          name: "Ideas",
          category: "idea",
          summary: "Short",
          content: "Long text",
        }),
      ),
    );
    expect(replyAs(z.array(SummarySchema), await runListNotes())).toEqual([
      { id: saved.id, name: "Ideas", category: "idea", summary: "Short" },
    ]);
    expect(
      replyAs(NoteSchema, await runReadNote(JSON.stringify({ id: saved.id })))
        .content,
    ).toBe("Long text");
  });

  test("save_note with an id updates that note, and delete_note removes it", async () => {
    const saved = replyAs(
      NoteSchema,
      await runSaveNote(
        JSON.stringify({
          name: "A",
          category: "c",
          summary: "s",
          content: "x",
        }),
      ),
    );
    const updated = replyAs(
      NoteSchema,
      await runSaveNote(
        JSON.stringify({
          id: saved.id,
          name: "A",
          category: "c",
          summary: "new",
          content: "y",
        }),
      ),
    );
    expect(updated).toMatchObject({ id: saved.id, summary: "new" });
    expect(await runDeleteNote(JSON.stringify({ id: saved.id }))).toBe(
      'Deleted note "A".',
    );
  });

  test("reports bad arguments back to the model as text", async () => {
    expect(await runSaveNote("not json")).toStartWith("Invalid arguments:");
    expect(await runReadNote(JSON.stringify({ id: "" }))).toStartWith(
      "Invalid arguments:",
    );
  });
});
