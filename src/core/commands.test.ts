import { expect, test } from "bun:test";
import { classifyLine } from "./commands.ts";
import { parseToolsCommand, toolStates } from "./tools.ts";

test("recognises /exit and /context after trimming and keeps other lines as messages", () => {
  expect(classifyLine("  /exit  ")).toEqual({ kind: "exit" });
  expect(classifyLine("/context")).toEqual({ kind: "context" });
  expect(classifyLine("/foo")).toEqual({ kind: "unknown-command", command: "/foo" });
  expect(classifyLine("exit")).toEqual({ kind: "message", text: "exit" });
  expect(classifyLine("quit")).toEqual({ kind: "message", text: "quit" });
});

test("reads /note and its words, but not a word that only starts with note", () => {
  expect(classifyLine("  /note new work plan ")).toEqual({ kind: "note", words: ["new", "work", "plan"] });
  expect(classifyLine("/note")).toEqual({ kind: "note", words: [] });
  expect(classifyLine("/notes")).toEqual({ kind: "unknown-command", command: "/notes" });
  expect(classifyLine("/profile terse")).toEqual({ kind: "profile", words: ["terse"] });
});

test("reads /tools: nothing lists, enable and disable take a tool name that exists", () => {
  expect(parseToolsCommand([])).toEqual({ ok: true, value: { kind: "list" } });
  expect(parseToolsCommand(["disable", "edit_file"])).toEqual({
    ok: true,
    value: { kind: "disable", name: "edit_file" },
  });
  expect(parseToolsCommand(["enable", "edit_file"])).toEqual({ ok: true, value: { kind: "enable", name: "edit_file" } });
  expect(parseToolsCommand(["disable", "nope"]).ok).toBe(false);
  expect(parseToolsCommand(["disable"]).ok).toBe(false);
  expect(toolStates(["edit_file"])).toContain("edit_file: off");
  expect(toolStates([])).toContain("kill_command: on");
});
