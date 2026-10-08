import { expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import { makeSubagentHandler } from "../src/tools/agent/subagent.ts";

const call = (id: string, name: string, args: object) => ({
  id,
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});

test("a subagent started by a subagent reports one level deeper", async () => {
  const replies = [
    {
      content: "",
      tool_calls: [
        call("1", "run_subagent", { task: "inner", profile: "default" }),
      ],
    },
    { content: "", tool_calls: [call("2", "echo", {})] },
    { content: "inner done" },
    { content: "outer done" },
  ];
  const client: Client = {
    chat: async () => ({ ok: true, value: replies.shift() ?? { content: "" } }),
  };
  const events: string[] = [];
  const runner: ToolRunner = {
    run: async (name, args) =>
      name === "run_subagent" ? handler(args) : "echoed",
  };
  const defs: Tool[] = [];
  const handler = makeSubagentHandler(
    client,
    {} as never,
    "/work",
    runner,
    defs,
    {
      onToolCall: (name, depth) => void events.push(`call ${name}@${depth}`),
      onToolResult: (name, depth) =>
        void events.push(`result ${name}@${depth}`),
    },
  );
  const result = await handler({ task: "outer", profile: "default" });
  expect(result).toBe("outer done");
  expect(events).toEqual([
    "call run_subagent@1",
    "call echo@2",
    "result echo@2",
    "result run_subagent@1",
  ]);
});
