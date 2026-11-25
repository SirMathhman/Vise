import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatStreamEvent } from "common";
import { decideApproval } from "../../src/chat/approvals";
import { streamChatReply } from "../../src/chat/tool-loop";
import { createNote } from "../../src/notes/notes-store";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

// Each upstream request gets the next scripted reply, and the last one repeats.
function fakeUpstream(replies: string[][]): string[] {
  const bodies: string[] = [];
  globalThis.fetch = ((_url: unknown, init?: RequestInit) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    const lines =
      replies[Math.min(bodies.length - 1, replies.length - 1)] ?? [];
    return Promise.resolve(new Response(`${lines.join("\n")}\n`));
  }) as typeof fetch;
  return bodies;
}

const callRound = (name: string, args: Record<string, string>): string[] => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}`,
];

const textRound = (text: string): string[] => [
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}`,
  `data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}`,
  "data: [DONE]",
];

// Reads the whole reply, answering each approval with the given choice as it arrives.
async function collect(
  answer: "approve" | "reject" | undefined,
): Promise<ChatStreamEvent[]> {
  const result = await streamChatReply("key", "openai/gpt-4o", [
    { role: "user", content: "go" },
  ]);
  if (!result.ok) {
    throw new Error(result.error);
  }
  const events: ChatStreamEvent[] = [];
  const reader = result.value.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) {
      return events;
    }
    events.push(next.value);
    if (next.value.type === "approval" && answer !== undefined) {
      decideApproval(next.value.id, answer);
    }
  }
}

describe("subagents", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vise-subagent-"));
    process.env.VISE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("the subagent's final answer comes back to the main reply as the tool result", async () => {
    const bodies = fakeUpstream([
      callRound("start_subagent", { task: "check it" }),
      textRound("sub answer"),
      textRound("final answer"),
    ]);
    const events = await collect(undefined);
    expect(events).toContainEqual({ type: "delta", text: "final answer" });
    expect(bodies[1]).toContain("check it");
    expect(bodies[2]).toContain("sub answer");
  });

  test("a subagent cannot start another subagent", async () => {
    const bodies = fakeUpstream([
      callRound("start_subagent", { task: "outer" }),
      callRound("start_subagent", { task: "inner" }),
      textRound("sub done"),
      textRound("final"),
    ]);
    await collect(undefined);
    expect(bodies[2]).toContain("A subagent cannot start another subagent.");
  });

  test("a subagent's approval reaches the client, and the answer goes back to the subagent", async () => {
    const note = await createNote({
      name: "A",
      category: "c",
      summary: "s",
      content: "x",
    });
    if (!note.ok) {
      throw new Error("setup failed");
    }
    const bodies = fakeUpstream([
      callRound("start_subagent", { task: "edit the note" }),
      callRound("save_note", {
        id: note.value.id,
        name: "A",
        category: "c",
        summary: "new",
        content: "y",
      }),
      textRound("sub done"),
      textRound("final"),
    ]);
    const events = await collect("reject");
    expect(events.find((e) => e.type === "approval")).toMatchObject({
      type: "approval",
      title: 'Update note "A"',
    });
    expect(bodies[2]).toContain("The user declined this change.");
  });
});
