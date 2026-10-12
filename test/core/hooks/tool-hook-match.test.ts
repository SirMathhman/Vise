import { expect, test } from "bun:test";
import {
  describeToolHook,
  matchesTool,
  parseToolHookEntries,
  toolHookConfig,
} from "../../../src/core/hooks/tool-hook-match.ts";

test("an entry with no tool list applies to every tool", () => {
  expect(matchesTool({ command: "x" }, "read_file", "files")).toBe(true);
  expect(matchesTool({ command: "x", tools: [] }, "read_file")).toBe(true);
});

test("a tool list matches the tool's name or its category", () => {
  const entry = { command: "x", tools: ["edit_file", "shell"] };
  expect(matchesTool(entry, "edit_file", "files")).toBe(true);
  expect(matchesTool(entry, "run_powershell", "shell")).toBe(true);
  expect(matchesTool(entry, "read_file", "files")).toBe(false);
  expect(matchesTool(entry, "read_file")).toBe(false);
});

test("config values parse from strings, objects and lists; bad entries are dropped", () => {
  expect(parseToolHookEntries("a")).toEqual([{ command: "a" }]);
  expect(parseToolHookEntries(undefined)).toEqual([]);
  expect(
    parseToolHookEntries([
      "a",
      "  ",
      { command: "b", tools: ["files", 3, ""] },
      { command: "c", tools: "files" },
      { tools: ["x"] },
      42,
      null,
    ]),
  ).toEqual([{ command: "a" }, { command: "b", tools: ["files"] }, { command: "c" }]);
});

test("an entry is saved as a bare string unless it has a tool filter", () => {
  expect(toolHookConfig({ command: "a" })).toBe("a");
  expect(toolHookConfig({ command: "a", tools: [] })).toBe("a");
  expect(toolHookConfig({ command: "a", tools: ["files"] })).toEqual({
    command: "a",
    tools: ["files"],
  });
  expect(describeToolHook({ command: "a", tools: ["x", "y"] })).toBe("a  [tools: x, y]");
});
