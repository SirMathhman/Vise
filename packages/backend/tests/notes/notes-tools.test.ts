import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NoteSchema, parseJson } from "common";
import { z } from "zod";
import type { Approval } from "../../src/chat/approvals";
import {
  runDeleteNote,
  runListNotes,
  runReadNote,
  runSaveNote,
} from "../../src/notes/notes-tools";

const SummarySchema = NoteSchema.omit({ content: true });

// The approval a tool proposed; fails the test when the tool answered with text instead.
function approvalOf(reply: string | Approval): Approval {
  if (typeof reply === "string") {
    throw new Error(`Expected an approval, got: ${reply}`);
  }
  return reply;
}

// Reads a tool's JSON reply through a zod schema, failing the test when it does not match or
// when the tool proposed an approval instead of answering.
function replyAs<S extends z.ZodType>(
  schema: S,
  reply: string | Approval,
): z.output<S> {
  if (typeof reply !== "string") {
    throw new Error("Expected a reply, got an approval");
  }
  const parsed = parseJson(schema, reply);
  if (!parsed.ok) {
    throw new Error(`Unexpected reply: ${reply}`);
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

  test("save_note with an id and delete_note wait for approval, and change the note only when applied", async () => {
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
    const update = approvalOf(
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
    expect(update.body).toContain("summary: s");
    expect(update.body).toContain("summary: new");
    expect(
      replyAs(NoteSchema, await runReadNote(JSON.stringify({ id: saved.id })))
        .summary,
    ).toBe("s");
    expect(replyAs(NoteSchema, await update.apply()).summary).toBe("new");

    const removal = approvalOf(
      await runDeleteNote(JSON.stringify({ id: saved.id })),
    );
    expect(removal.title).toBe('Delete note "A"');
    expect(await removal.apply()).toBe('Deleted note "A".');
    expect(await runReadNote(JSON.stringify({ id: saved.id }))).toBe(
      "No note has that id.",
    );
  });

  test("reports bad arguments back to the model as text", async () => {
    expect(await runSaveNote("not json")).toStartWith("Invalid arguments:");
    expect(await runReadNote(JSON.stringify({ id: "" }))).toStartWith(
      "Invalid arguments:",
    );
  });
});
