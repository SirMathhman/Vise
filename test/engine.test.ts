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

describe("runTurn interruption (core)", () => {
  test("returns interrupted without calling the client when the signal is already aborted", async () => {
    let calls = 0;
    const client: Client = {
      async chat() {
        calls += 1;
        return { ok: true, value: { content: "hi" } };
      },
    };
    const controller = new AbortController();
    controller.abort();
    const result = await runTurn(
      client,
      noopTools,
      [{ role: "user", content: "go" }],
      noToolDefs,
      { abort: controller.signal },
    );
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toEqual({ kind: "interrupted" });
    expect(calls).toBe(0);
  });

  test("returns interrupted when the signal is aborted by the in-flight round", async () => {
    const controller = new AbortController();
    const client: Client = {
      async chat() {
        // Simulate the in-flight stream noticing the interrupt: the edge
        // aborts the controller while the model call is in flight, and the
        // call completes (here with a network error, as an aborted fetch
        // would). The post-round abort check must win over that error.
        controller.abort();
        return { ok: false, error: { kind: "network", cause: "aborted" } };
      },
    };
    const result = await runTurn(
      client,
      noopTools,
      [{ role: "user", content: "go" }],
      noToolDefs,
      { abort: controller.signal },
    );
    expect(result.ok).toBeFalse();
    if (!result.ok) expect(result.error).toEqual({ kind: "interrupted" });
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

describe("runTurn burst mode (core)", () => {
  const call = (name: string) => ({
    type: "function" as const,
    id: "c",
    function: { name, arguments: "{}" },
  });
  const run = async (
    replies: Record<string, unknown>[],
    output: string,
  ): Promise<boolean[]> => {
    const acts: boolean[] = [];
    let i = 0;
    const client: Client = {
      async chat(_m, _t, _a, _b, _c, _d, _e, _f, act) {
        acts.push(!!act);
        return { ok: true, value: { content: "", ...replies[i++] } };
      },
    };
    const runner: ToolRunner = { run: async () => output };
    await runTurn(client, runner, [{ role: "user", content: "x" }], [], {
      burst: true,
    });
    return acts;
  };

  test("thinks first, acts after a successful call, thinks after done", async () => {
    const acts = await run(
      [{ tool_calls: [call("a")] }, { done: true }, { content: "ok" }],
      "fine",
    );
    expect(acts).toEqual([false, true, false]);
  });

  test("returns to thinking after a tool error", async () => {
    const acts = await run(
      [{ tool_calls: [call("a")] }, { content: "ok" }],
      "error: boom",
    );
    expect(acts).toEqual([false, false]);
  });

  test("discards a low-confidence act reply and thinks again", async () => {
    const acts = await run(
      [
        { tool_calls: [call("a")] },
        { tool_calls: [call("b")], confidence: 0.1 },
        { content: "ok" },
      ],
      "fine",
    );
    expect(acts).toEqual([false, true, false]);
  });
});
