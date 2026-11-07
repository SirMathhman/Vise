import { expect, test } from "bun:test";
import { Readable, Writable } from "node:stream";
import type { ChatMessage, Reply, ToolCall } from "../../core/messages.ts";
import { err, ok } from "../../core/result.ts";
import { runWithPorts } from "../../repl/session-helper.ts";
import type { SessionPorts } from "../ports.ts";
import {
  queueApprovals,
  runSubagent,
  type SubagentContext,
  type SubagentPorts,
} from "./subagent.ts";

interface ScriptedRound {
  text: string;
  calls?: ToolCall[];
}

// A reply that answers each request with the next scripted round, and records the tools offered.
function scripted(rounds: ScriptedRound[], offered: string[][]): Reply {
  let next = 0;
  return async function* ({ onToolCall, tools }) {
    offered.push(tools);
    const round = rounds[next] ?? { text: "" };
    next += 1;
    for (const call of round.calls ?? []) onToolCall(call);
    yield ok(round.text);
  };
}

function subPorts(
  reply: Reply,
  tools: SubagentPorts["tools"] = async () => "a.txt",
): SubagentPorts {
  return {
    reply,
    tools,
    hooks: async () => ok(""),
    profile: async () => ok("Be careful."),
    profileTools: async () => ok(["list_files", "run_subagent"]),
    profileHooks: async () => ok([]),
  };
}

function context(ports: SubagentPorts): SubagentContext {
  return {
    ports,
    approve: async () => true,
    finished: () => false,
    emit: () => {},
    disabledTools: [],
  };
}

test("a subagent runs its tool calls, is not offered the subagent tool, and returns its final answer", async () => {
  const offered: string[][] = [];
  const reply = scripted(
    [
      {
        text: "",
        calls: [{ id: "c1", name: "list_files", arguments: '{"path":"."}' }],
      },
      { text: "done" },
    ],
    offered,
  );
  const result = await runSubagent(
    { profile: "reader", task: "look", maxToolCalls: 3 },
    context(subPorts(reply)),
  );
  expect(result).toBe("done");
  expect(offered[0]).toEqual(["list_files"]);
});

test("a subagent at its limit is asked once more with no tools, and its answer is marked cut short", async () => {
  const offered: string[][] = [];
  const call = (id: string): ToolCall => ({
    id,
    name: "list_files",
    arguments: '{"path":"."}',
  });
  const reply = scripted(
    [{ text: "", calls: [call("c1")] }, { text: "partial" }],
    offered,
  );
  const result = await runSubagent(
    { profile: "reader", task: "look", maxToolCalls: 1 },
    context(subPorts(reply)),
  );
  expect(result).toBe("[cut short after 1 tool calls]\npartial");
  expect(offered.at(-1)).toEqual([]);
});

test("approvals asked together are answered one after another, in the order asked", async () => {
  const order: string[] = [];
  let release: () => void = () => {};
  const approve = async (preview: string) => {
    order.push(`start ${preview}`);
    if (preview === "first")
      await new Promise<void>((done) => (release = done));
    order.push(`end ${preview}`);
    return true;
  };
  const queued = queueApprovals(approve);
  const a = queued("first");
  const b = queued("second");
  await Promise.resolve();
  expect(order).toEqual(["start first"]);
  release();
  await Promise.all([a, b]);
  expect(order).toEqual([
    "start first",
    "end first",
    "start second",
    "end second",
  ]);
});

test("two subagents asked for in one reply both run, and each result reaches the main model", async () => {
  const seenByMain: string[][] = [];
  const reply: Reply = async function* ({ messages, onToolCall }) {
    const first = messages[0]?.content ?? "";
    if (first.startsWith("Be careful.")) {
      const task = messages.at(-1)?.content ?? "";
      yield ok(`answer for ${task.split("\n\n").at(-1)}`);
      return;
    }
    if (messages.at(-1)?.role === "user") {
      onToolCall({
        id: "s1",
        name: "run_subagent",
        arguments: '{"profile":"reader","task":"a","max_tool_calls":1}',
      });
      onToolCall({
        id: "s2",
        name: "run_subagent",
        arguments: '{"profile":"reader","task":"b","max_tool_calls":1}',
      });
      return;
    }
    seenByMain.push(
      messages
        .filter((message: ChatMessage) => message.role === "tool")
        .map((message) => message.content),
    );
    yield ok("main done");
  };
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  const ports: SessionPorts = {
    reply,
    contextWindow: async () => err(new Error("none")),
    tools: async () => "unused",
    notes: async () => "",
    profile: async () => ok("Be careful."),
    profileTools: async () => ok(["list_files"]),
    profileHooks: async () => ok([]),
    disabledTools: [],
    saveDisabledTools: async () => ok(undefined),
    sessions: {
      save: async () => ok(undefined),
      load: async () => err(new Error("none")),
      list: async () => ok([]),
    },
    hooks: async () => ok(""),
    models: {
      current: () => "m",
      list: async () => ok([]),
      select: async (name: string) => ok(name),
    },
  };
  await runWithPorts(Readable.from(["go\n", "/exit\n"]), output, ports);
  expect(seenByMain.at(-1)).toEqual(["answer for a", "answer for b"]);
});

test("a subagent is not offered a tool that the user switched off", async () => {
  const offered: string[][] = [];
  const reply = scripted([{ text: "done" }], offered);
  await runSubagent(
    { profile: "reader", task: "look", maxToolCalls: 3 },
    { ...context(subPorts(reply)), disabledTools: ["list_files"] },
  );
  expect(offered[0]).toEqual([]);
});
