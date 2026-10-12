import { describe, expect, test } from "bun:test";
import { summarize, type Client, type Tool } from "@vise/core";
import type { Message } from "@vise/core";
import { runWorkflow } from "@vise/core";
import { encodeMessages } from "../../src/client/tool-protocol.ts";
import { chooseSideSlot, slotJustUsed } from "../../src/client/slots.ts";

const readFile: Tool = {
  type: "function",
  function: {
    name: "read_file",
    description: "Read a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
};

type ChatArgs = Parameters<Client["chat"]>;

/** A client that keeps what every call was given and answers with `reply`. */
function recording(reply: string): { client: Client; calls: ChatArgs[] } {
  const calls: ChatArgs[] = [];
  return {
    calls,
    client: {
      async chat(...args) {
        calls.push(args);
        return { ok: true, value: { content: reply } };
      },
    },
  };
}

describe("prompt-cache sharing", () => {
  test("workflow argument generation is sent with the tool list, like the conversation's own turns", async () => {
    const { client, calls } = recording('{"path":"a.ts"}');
    await runWorkflow({
      client,
      tools: { run: async () => "contents" },
      toolDefs: [readFile],
      messages: [{ role: "system", content: "s" }],
      name: "wf",
      workflow: { steps: [{ type: "tool", name: "read_file", args: { path: "<path>" } }] },
      request: "",
      callbacks: {},
    });
    const generation = calls.find((c) => c[5] !== undefined);
    expect(generation).toBeDefined();
    expect(generation?.[1]).toEqual([readFile]);
    // The encoded request opens with the same system message a normal reply does.
    const history: Message[] = [{ role: "system", content: "s" }];
    const normal = encodeMessages(history, [readFile])[0];
    const asked = encodeMessages([...history, { role: "user", content: "q" }], generation?.[1] ?? [])[0];
    expect(asked).toEqual(normal);
  });

  test("a summary request carries the conversation's system message and tool list, and calls no tool", async () => {
    const { client, calls } = recording("summary");
    const system: Message = { role: "system", content: "global prompt" };
    const old: Message = { role: "user", content: "hello" };
    const result = await summarize(client, [old], { system, tools: [readFile] });
    expect(result).toEqual({ ok: true, value: "summary" });
    const [messages, tools, , , , , , isToolEnabled] = calls[0] as ChatArgs;
    expect(messages[0]).toEqual(system);
    expect(messages[1]).toEqual(old);
    expect(tools).toEqual([readFile]);
    expect(isToolEnabled?.("read_file")).toBe(false);
  });

  test("a summary request without a prefix is unchanged", async () => {
    const { client, calls } = recording("summary");
    await summarize(client, [{ role: "user", content: "hello" }]);
    expect(calls[0]?.[1]).toBeUndefined();
    expect(calls[0]?.[0]).toHaveLength(2);
  });
});

describe("side slot choice", () => {
  const slots = [
    { id: 0, id_task: 50 },
    { id: 1, id_task: 90 },
    { id: 2, id_task: 10 },
  ];

  test("without a known main slot, the slot used last is taken as the main one", () => {
    expect(slotJustUsed(slots)).toBe(1);
    expect(chooseSideSlot(slots, undefined)).toBe(2);
  });

  test("a known main slot is never chosen, even when another slot ran the latest task", () => {
    // The main conversation is on slot 0; something else ran last on slot 1.
    expect(chooseSideSlot(slots, 0)).toBe(2);
    expect(chooseSideSlot([{ id: 0, id_task: 5 }, { id: 1, id_task: 9 }], 0)).toBe(1);
  });

  test("a single slot or missing task numbers leave the work unpinned", () => {
    expect(chooseSideSlot([{ id: 0, id_task: 1 }], undefined)).toBeUndefined();
    expect(chooseSideSlot([{ id: 0 }, { id: 1 }], 0)).toBeUndefined();
  });
});
