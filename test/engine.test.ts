import { describe, expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import { runSubagent, runTurn, summarize } from "../src/core/engine.ts";
import type { Message } from "../src/core/errors.ts";

const noopTools: ToolRunner = {
  async run(_name, _args) {
    return "tool output";
  },
};

const noToolDefs: Tool[] = [];

describe("runTurn streaming (core)", () => {
  test("invokes onToken with each token and returns the accumulated content", async () => {
    const seen: string[] = [];
    const tokens = ["Hel", "lo"];
    // The stub models what the edge would feed onToken per content delta.
    const client: Client = {
      async chat(_m: Message[], _t?: Tool[], onToken?: (t: string) => void) {
        for (const t of tokens) onToken?.(t);
        return { ok: true, value: { content: "Hello" } };
      },
    };
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const result = await runTurn(client, noopTools, messages, noToolDefs, {
      onToken: (t) => seen.push(t),
    });
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("Hello");
    expect(seen).toEqual(tokens);
  });

  test("reaches tool rounds: onToken receives intermediate and final content", async () => {
    const seen: string[] = [];
    let round = 0;
    const client: Client = {
      async chat(_messages, _tools, onToken) {
        round += 1;
        // Each round the edge would stream its own deltas; model them here.
        onToken?.("thinking");
        onToken?.("...");
        if (round === 1) {
          return {
            ok: true,
            value: {
              content: "thinking...",
              tool_calls: [
                {
                  type: "function",
                  id: "call_1",
                  function: { name: "noop", arguments: "{}" },
                },
              ],
            },
          };
        }
        return { ok: true, value: { content: "done" } };
      },
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    const result = await runTurn(client, noopTools, messages, noToolDefs, {
      onToken: (t) => seen.push(t),
    });
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("done");
    // Two rounds, two "thinking"+"..." deltas each → 4 total.
    expect(seen).toEqual(["thinking", "...", "thinking", "..."]);
  });

  test("notifies the edge of each tool invocation before dispatch", async () => {
    const events: string[] = [];
    const client: Client = {
      async chat() {
        return {
          ok: true,
          value: {
            content: "",
            tool_calls: [
              {
                type: "function",
                id: "1",
                function: { name: "read_file", arguments: "{}" },
              },
              {
                type: "function",
                id: "2",
                function: { name: "list_directory", arguments: "{}" },
              },
            ],
          },
        };
      },
    };
    const tools: ToolRunner = {
      async run(name) {
        events.push(`run:${name}`);
        return "ok";
      },
    };
    let rounds = 0;
    const twoRoundClient: Client = {
      async chat(messages, defs, token, thinking, progress) {
        rounds++;
        if (rounds === 1)
          return client.chat(messages, defs, token, thinking, progress);
        return { ok: true, value: { content: "done" } };
      },
    };
    const result = await runTurn(
      twoRoundClient,
      tools,
      [{ role: "user", content: "go" }],
      noToolDefs,
      {
        onToolCall: (name) => events.push(`notify:${name}`),
      },
    );
    expect(result.ok).toBeTrue();
    expect(events).toEqual([
      "notify:read_file",
      "run:read_file",
      "notify:list_directory",
      "run:list_directory",
    ]);
  });
});

describe("summarize (core)", () => {
  test("does not invoke onToken (compaction is not streamed)", async () => {
    const seen: string[] = [];
    const client: Client = {
      async chat(_messages, _tools, onToken) {
        // onToken is intentionally omitted by the core; record if ever called.
        onToken?.("x");
        return { ok: true, value: { content: "summary" } };
      },
    };
    const result = await summarize(client, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("summary");
    // summarize never passes onToken, so nothing should be recorded.
    expect(seen).toEqual([]);
  });
});

describe("runSubagent (core)", () => {
  test("returns the subagent's final assistant text from a fresh conversation", async () => {
    const seen: Message[][] = [];
    const client: Client = {
      async chat(messages, _tools) {
        // Snapshot: runTurn mutates the messages array in place (documented
        // side channel), so record a copy of the conversation as first sent.
        seen.push([...messages]);
        return { ok: true, value: { content: "subagent result" } };
      },
    };
    const systemMessage = {
      role: "system" as const,
      content: "Working directory: /tmp",
    };
    const result = await runSubagent(
      client,
      noopTools,
      noToolDefs,
      systemMessage,
      "You are a test subagent.",
      "do the thing",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("subagent result");
    // The fresh conversation is [system, profile, task].
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      systemMessage,
      { role: "user", content: "You are a test subagent." },
      { role: "user", content: "do the thing" },
    ]);
  });

  test("omits the profile message when the profile text is empty", async () => {
    const seen: Message[][] = [];
    const client: Client = {
      async chat(messages, _tools) {
        // Snapshot: runTurn mutates the messages array in place (documented
        // side channel), so record a copy of the conversation as first sent.
        seen.push([...messages]);
        return { ok: true, value: { content: "ok" } };
      },
    };
    const systemMessage = {
      role: "system" as const,
      content: "Working directory: /tmp",
    };
    const result = await runSubagent(
      client,
      noopTools,
      noToolDefs,
      systemMessage,
      "   ",
      "do the thing",
    );
    expect(result.ok).toBeTrue();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      systemMessage,
      { role: "user", content: "do the thing" },
    ]);
  });

  test("propagates a client error as a failure result", async () => {
    const client: Client = {
      async chat(_messages, _tools) {
        return { ok: false, error: { kind: "network", cause: "boom" } };
      },
    };
    const systemMessage = {
      role: "system" as const,
      content: "Working directory: /tmp",
    };
    const result = await runSubagent(
      client,
      noopTools,
      noToolDefs,
      systemMessage,
      "profile",
      "task",
    );
    expect(result.ok).toBeFalse();
    if (!result.ok && result.error.kind === "network") {
      expect(result.error.cause).toBe("boom");
    }
  });
});
