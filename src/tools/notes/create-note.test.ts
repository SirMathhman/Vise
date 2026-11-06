import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scaffold } from "../../core/notes.ts";
import { createNote } from "./create-note.ts";

test("creates the note with its header under notes/<category>, and refuses an existing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-note-"));
  expect(await createNote(root, "work", "plan")).toEqual({
    ok: true,
    value: `created ${join("notes", "work", "plan.md")}`,
  });
  expect(await readFile(join(root, "notes", "work", "plan.md"), "utf8")).toBe(scaffold("work", "plan"));
  const again = await createNote(root, "work", "plan");
  expect(again.ok).toBe(false);
});
