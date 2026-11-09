import { expect, test } from "bun:test";
import { classifyLine, mcpStatusText } from "./commands.ts";
import { parseAskLine, askResultText } from "./tool-lines.ts";
import { parseAskArgs } from "./tools.ts";
import { parseSubagentArgs, parseToolsCommand, toolNames, toolStates } from "./tools.ts";
import {
  helpText,
  parseModelCommand,
  parseThinkingCommand,
  type HelpName,
} from "./commands.ts";

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
  expect(parseToolsCommand([], toolNames)).toEqual({ ok: true, value: { kind: "list" } });
  expect(parseToolsCommand(["disable", "edit_file"], toolNames)).toEqual({
    ok: true,
    value: { kind: "disable", name: "edit_file" },
  });
  expect(parseToolsCommand(["enable", "edit_file"], toolNames)).toEqual({
    ok: true,
    value: { kind: "enable", name: "edit_file" },
  });
  expect(parseToolsCommand(["disable", "nope"], toolNames).ok).toBe(false);
  expect(parseToolsCommand(["disable"], toolNames).ok).toBe(false);
  expect(toolStates(toolNames, ["edit_file"])).toContain("edit_file: off");
  expect(toolStates(toolNames, [])).toContain("kill_command: on");
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

test("reads /help and its words, and lists every command or describes the one named", () => {
  expect(classifyLine("/help")).toEqual({ kind: "help", words: [] });
  expect(classifyLine("  /help  model ")).toEqual({
    kind: "help",
    words: ["model"],
  });
  const list = helpText([]);
  expect(list.ok && list.value.split("\n")).toHaveLength(14);
  expect(list.ok && list.value).toContain("/model [search <text> | <name>]");
  const model = helpText(["/model"]);
  expect(model.ok && model.value.startsWith("/model [search <text> | <name>]\n")).toBe(true);
  expect(model.ok && model.value).toContain("saved for the next session");
  expect(helpText(["nope"]).ok).toBe(false);
  expect(helpText(["model", "search"]).ok).toBe(false);
});

test("every command the help table names is recognised by the classifier", () => {
  const names: HelpName[] = [
    "exit", "context", "compact", "note", "profile", "tools", "thinking",
    "model", "save", "load", "sessions", "new", "help",
  ];
  for (const name of names) {
    expect(classifyLine(`/${name}`).kind).not.toBe("unknown-command");
  }
});

test("/mcp is a command with no words; its text lists each server and its problems", () => {
  expect(classifyLine("/mcp")).toEqual({ kind: "mcp", words: [] });
  expect(classifyLine("/mcp now")).toEqual({ kind: "mcp", words: ["now"] });
  expect(mcpStatusText([])).toBe("no MCP servers are configured in .vise/mcp.json");
  expect(
    mcpStatusText([
      { name: "fake", started: true, tools: ["fake__echo"], problems: [] },
      { name: "gone", started: false, tools: [], problems: ["gone: spawn failed"] },
    ]),
  ).toBe(
    "fake: started, 1 tools: fake__echo\ngone: did not start\n  gone: spawn failed",
  );
});

test("ask_user needs a question and at least one choice; a line picks numbers or is the user's own answer", () => {
  expect(parseAskArgs('{"question":"Which?","choices":["a","b"]}')).toEqual({
    ok: true,
    value: { question: "Which?", choices: ["a", "b"] },
  });
  expect(parseAskArgs('{"question":"Which?","choices":[]}').ok).toBe(false);
  expect(parseAskArgs('{"question":"","choices":["a"]}').ok).toBe(false);
  expect(parseAskLine("2, 1, 2", ["a", "b"])).toEqual({ chosen: ["b", "a"], text: "" });
  expect(parseAskLine("3", ["a", "b"])).toEqual({ chosen: [], text: "3" });
  expect(parseAskLine("  ok  ", ["a", "b"])).toEqual({ chosen: [], text: "ok" });
  expect(askResultText({ chosen: [], text: "" })).toBe("the user gave no answer");
  expect(askResultText({ chosen: ["a"], text: "and more" })).toBe(
    "the user chose: a; the user answered: and more",
  );
});
