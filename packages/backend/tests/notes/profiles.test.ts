import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNote } from "../../src/notes/notes-store";
import { profileInstructions } from "../../src/notes/profiles";

describe("profile instructions", () => {
  beforeEach(() => {
    process.env.VISE_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), "vise-profiles-"),
    );
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("a profile note gives its content, and other notes and missing ids are refused", async () => {
    const profile = await createNote({
      name: "Terse",
      category: "profile",
      summary: "Short answers",
      content: "Answer in one sentence.",
    });
    const note = await createNote({
      name: "Shopping",
      category: "todo",
      summary: "",
      content: "Milk",
    });
    if (!profile.ok || !note.ok) {
      throw new Error("setup failed");
    }
    expect(await profileInstructions(profile.value.id)).toEqual({
      ok: true,
      value: "Answer in one sentence.",
    });
    expect(await profileInstructions(note.value.id)).toEqual({
      ok: false,
      error: 'The note "Shopping" is not a profile.',
    });
    expect(await profileInstructions("missing")).toEqual({
      ok: false,
      error: "No note has that id.",
    });
  });
});
