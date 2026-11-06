import { expect, test } from "bun:test";
import { classifyLine } from "./commands.ts";
import { parseSubagentArgs, parseToolsCommand, toolStates } from "./tools.ts";
import { parseModelCommand, parseThinkingCommand } from "./commands.ts";

test("recognises /exit and /context after trimming and keeps other lines as messages", () => {
  expect(classifyLine("  /exit  ")).toEqual({ kind: "exit" });
  expect(classifyLine("/context")).toEqual({ kind: "context" });
  expect(classifyLine("/foo")).toEqual({
    kind: "unknown-command",
    command: "/foo",
  });
  expect(classifyLine("exit")).toEqual({ kind: "message", text: "exit" });
  expect(classifyLine("quit")).toEqual({ kind: "message", text: "quit" });
});

test("reads /note and its words, but not a word that only starts with note", () => {
  expect(classifyLine("  /note new work plan ")).toEqual({
    kind: "note",
    words: ["new", "work", "plan"],
  });
  expect(classifyLine("/note")).toEqual({ kind: "note", words: [] });
  expect(classifyLine("/notes")).toEqual({
    kind: "unknown-command",
    command: "/notes",
  });
  expect(classifyLine("/profile terse")).toEqual({
    kind: "profile",
    words: ["terse"],
  });
});

test("reads /tools: nothing lists, enable and disable take a tool name that exists", () => {
  expect(parseToolsCommand([])).toEqual({ ok: true, value: { kind: "list" } });
  expect(parseToolsCommand(["disable", "edit_file"])).toEqual({
    ok: true,
    value: { kind: "disable", name: "edit_file" },
  });
  expect(parseToolsCommand(["enable", "edit_file"])).toEqual({
    ok: true,
    value: { kind: "enable", name: "edit_file" },
  });
  expect(parseToolsCommand(["disable", "nope"]).ok).toBe(false);
  expect(parseToolsCommand(["disable"]).ok).toBe(false);
  expect(toolStates(["edit_file"])).toContain("edit_file: off");
  expect(toolStates([])).toContain("kill_command: on");
});

test("reads run_subagent arguments: a profile name, a task, and a whole-number limit of at least 1", () => {
  expect(
    parseSubagentArgs('{"profile":"reader","task":"look","max_tool_calls":2}'),
  ).toEqual({
    ok: true,
    value: { profile: "reader", task: "look", maxToolCalls: 2 },
  });
  expect(
    parseSubagentArgs('{"profile":"reader","task":"look","max_tool_calls":0}')
      .ok,
  ).toBe(false);
  expect(
    parseSubagentArgs('{"profile":"reader","task":" ","max_tool_calls":2}').ok,
  ).toBe(false);
  expect(
    parseSubagentArgs('{"profile":"a/b","task":"look","max_tool_calls":2}').ok,
  ).toBe(false);
});

test("reads /thinking: nothing shows, and off, low, medium, or high sets it", () => {
  expect(parseThinkingCommand([])).toEqual({
    ok: true,
    value: { kind: "show" },
  });
  expect(parseThinkingCommand(["low"])).toEqual({
    ok: true,
    value: { kind: "set", effort: "low" },
  });
  expect(parseThinkingCommand(["off"])).toEqual({
    ok: true,
    value: { kind: "set", effort: undefined },
  });
  expect(parseThinkingCommand(["max"]).ok).toBe(false);
});

test("reads /model: nothing shows the model in use, search lists matches, and a name selects one", () => {
  expect(parseModelCommand([])).toEqual({ ok: true, value: { kind: "show" } });
  expect(parseModelCommand(["search", "claude"])).toEqual({
    ok: true,
    value: { kind: "search", snippet: "claude" },
  });
  expect(parseModelCommand(["search"]).ok).toBe(false);
  expect(parseModelCommand(["openai/gpt-x"])).toEqual({
    ok: true,
    value: { kind: "select", name: "openai/gpt-x" },
  });
  expect(parseModelCommand(["a", "b"]).ok).toBe(false);
});
