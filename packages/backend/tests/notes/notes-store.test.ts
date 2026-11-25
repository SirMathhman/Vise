import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createNote,
  deleteNote,
  getNote,
  listNotes,
  updateNote,
} from "../../src/notes/notes-store";

const input = {
  name: "Plan",
  category: "todo",
  summary: "Next steps",
  content: "Write the tests.",
};

describe("notes store", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vise-notes-"));
    process.env.VISE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("creates a note, keeps it in the config folder, and reads it back", async () => {
    const created = await createNote(input);
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    expect(existsSync(path.join(dir, "notes.json"))).toBe(true);
    expect(await getNote(created.value.id)).toEqual({
      ok: true,
      value: created.value,
    });
    expect(await listNotes()).toEqual({ ok: true, value: [created.value] });
  });

  test("refuses a name already used, ignoring case, and keeps a note's own name on update", async () => {
    const first = await createNote(input);
    expect(await createNote({ ...input, name: "PLAN" })).toEqual({
      ok: false,
      error: "name-taken",
    });
    if (!first.ok) {
      return;
    }
    expect(
      await updateNote(first.value.id, { ...input, summary: "Changed" }),
    ).toMatchObject({
      ok: true,
      value: { id: first.value.id, summary: "Changed" },
    });
    const second = await createNote({ ...input, name: "Other" });
    if (!second.ok) {
      return;
    }
    expect(await updateNote(second.value.id, { ...input })).toEqual({
      ok: false,
      error: "name-taken",
    });
  });

  test("reports a missing id on read, update, and delete, and deletes a note", async () => {
    expect(await getNote("missing")).toEqual({ ok: false, error: "not-found" });
    expect(await updateNote("missing", input)).toEqual({
      ok: false,
      error: "not-found",
    });
    const created = await createNote(input);
    if (!created.ok) {
      return;
    }
    expect(await deleteNote(created.value.id)).toEqual({
      ok: true,
      value: created.value,
    });
    expect(await listNotes()).toEqual({ ok: true, value: [] });
    expect(await deleteNote(created.value.id)).toEqual({
      ok: false,
      error: "not-found",
    });
  });
});
