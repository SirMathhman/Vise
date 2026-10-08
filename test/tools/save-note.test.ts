import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NoteStore } from "../../src/stores/note-store.ts";
import { saveNoteTool } from "../../src/tools/notes-tool.ts";

const store = (): { store: NoteStore; project: string } => {
  const base = mkdtempSync(join(tmpdir(), "vise-notes-"));
  return {
    store: new NoteStore({ project: join(base, "p"), global: join(base, "g") }),
    project: join(base, "p"),
  };
};

test("a note is saved with its text", () => {
  const { store: s, project } = store();
  const out = saveNoteTool(
    { scope: "project", category: "plans", name: "p1", body: "Plan: x\nsteps" },
    s,
  );
  expect(out).toBe("saved project note 'p1'");
  expect(
    readFileSync(join(project, "notes", "plans", "p1.md"), "utf8"),
  ).toContain("steps");
});

test("text sent under another name is refused with the right name, never saved as an empty note", () => {
  const { store: s } = store();
  const out = saveNoteTool(
    { scope: "project", name: "p2", content: "the plan" },
    s,
  );
  expect(out).toBe(
    "error: save_note takes the note's text as 'body', not 'content'; nothing was saved",
  );
  expect(
    saveNoteTool({ scope: "project", name: "p3", body: "   " }, s),
  ).toContain("non-empty 'body'");
  expect(s.read({ scope: "project", name: "p2" })).toBeUndefined();
});
