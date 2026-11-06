import { expect, test } from "bun:test";
import { bodyOf, checkName, notePath, parseHeader, parseNoteCommand, parseProfileCommand, scaffold } from "./notes.ts";

test("accepts names of letters, digits, - and _ only", () => {
  expect(checkName("meeting-2026_notes", "name").ok).toBe(true);
  for (const bad of ["", "a/b", "..", "a b", "x.md"]) {
    expect(checkName(bad, "name").ok).toBe(false);
  }
});

test("a scaffold reads back with its name, category, and an empty summary", () => {
  expect(notePath("work", "plan")).toBe("notes/work/plan.md");
  expect(parseHeader(scaffold("work", "plan"))).toEqual({
    ok: true,
    value: { name: "plan", category: "work", summary: "" },
  });
});

test("reads a header with CRLF line endings and refuses a text without one", () => {
  const text = "---\r\nname: plan\r\ncategory: work\r\nsummary: Q3 goals\r\n---\r\nbody";
  expect(parseHeader(text)).toEqual({
    ok: true,
    value: { name: "plan", category: "work", summary: "Q3 goals" },
  });
  expect(parseHeader("just text").ok).toBe(false);
});

test("parses /note new and /note list, and refuses any other use", () => {
  expect(parseNoteCommand(["new", "work", "plan"])).toEqual({
    ok: true,
    value: { kind: "new", category: "work", name: "plan" },
  });
  expect(parseNoteCommand(["list"])).toEqual({ ok: true, value: { kind: "list" } });
  expect(parseNoteCommand(["list", "work"])).toEqual({ ok: true, value: { kind: "list", category: "work" } });
  expect(parseNoteCommand(["new", "work"]).ok).toBe(false);
  expect(parseNoteCommand(["new", "work", "a/b"]).ok).toBe(false);
  expect(parseNoteCommand(["list", "a", "b"]).ok).toBe(false);
  expect(parseNoteCommand([]).ok).toBe(false);
});

test("the body is the text below the header, and /profile reads show, default, or a name", () => {
  expect(bodyOf("---\nname: t\ncategory: profile\nsummary:\n---\n\n# t\n\nBe brief.\n")).toBe("# t\n\nBe brief.");
  expect(bodyOf("no header")).toBe("");
  expect(parseProfileCommand([])).toEqual({ ok: true, value: { kind: "show" } });
  expect(parseProfileCommand(["default"])).toEqual({ ok: true, value: { kind: "clear" } });
  expect(parseProfileCommand(["terse"])).toEqual({ ok: true, value: { kind: "use", name: "terse" } });
  expect(parseProfileCommand(["a", "b"]).ok).toBe(false);
  expect(parseProfileCommand(["a/b"]).ok).toBe(false);
});
