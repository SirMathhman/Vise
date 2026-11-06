import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNote } from "./create-note.ts";
import { listNotes } from "./list-notes.ts";

test("lists the notes sorted, with each summary, and filters by category", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-list-"));
  expect(await listNotes(root)).toEqual({ ok: true, value: "(no notes)" });
  await createNote(root, "work", "plan");
  await createNote(root, "home", "shopping");
  await writeFile(
    join(root, "notes", "work", "plan.md"),
    "---\nname: plan\ncategory: work\nsummary: Q3 goals\n---\n# plan\n",
  );
  expect(await listNotes(root)).toEqual({ ok: true, value: "home/shopping\nwork/plan - Q3 goals" });
  expect(await listNotes(root, "work")).toEqual({ ok: true, value: "work/plan - Q3 goals" });
});

test("lists a note with an unreadable header, with the reason in place of its summary", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-list-"));
  await mkdir(join(root, "notes", "misc"), { recursive: true });
  await writeFile(join(root, "notes", "misc", "bare.md"), "no header here");
  expect(await listNotes(root)).toEqual({ ok: true, value: "misc/bare - (the note has no header)" });
});
