import { expect, test } from "bun:test";
import type { ToolCall } from "../../core/messages.ts";
import { SEARCH_TOOLS, type ToolSpec } from "../../core/tools.ts";
import { runCalls, type CallsStep } from "./calls.ts";

const docs: ToolSpec = { type: "function", function: { name: "rea__comment", description: "Set a comment", parameters: {} } };

function stepFor(calls: ToolCall[], found: string[][]): CallsStep {
  return {
    calls,
    tools: async () => "unused",
    approve: async () => true,
    ask: async () => "unused",
    finished: () => false,
    offered: [SEARCH_TOOLS],
    emit: () => {},
    subagents: {} as CallsStep["subagents"],
    disabledTools: [],
    mcpSpecs: [docs],
    remember: (names) => {
      found.push(names);
    },
  };
}

test("a search call reports the matching tools and remembers them for the next request", async () => {
  const found: string[][] = [];
  const call: ToolCall = { id: "1", name: SEARCH_TOOLS, arguments: '{"query":"comment"}' };
  const messages = await runCalls(stepFor([call], found));
  expect(found).toEqual([["rea__comment"]]);
  expect(messages).toEqual([{ role: "tool", toolCallId: "1", content: "rea__comment: Set a comment" }]);
});

test("a search that matches nothing says so and remembers nothing", async () => {
  const found: string[][] = [];
  const call: ToolCall = { id: "2", name: SEARCH_TOOLS, arguments: '{"query":"absent"}' };
  const messages = await runCalls(stepFor([call], found));
  expect(found).toEqual([[]]);
  expect(messages[0]?.content).toBe("no tool matches; try other words");
});
