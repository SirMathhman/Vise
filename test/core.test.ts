import { describe, test, expect } from "bun:test";
import { runTurn, summarize } from "../src/core/engine.ts";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import type { Message, AssistantMessage } from "../src/core/errors.ts";
import { Session } from "../src/repl/session.ts";
import type { ContextSource } from "../src/repl/session.ts";

const noopTools: ToolRunner = {
  async run(_name, _args) {
    return "tool output";
  },
};

const noToolDefs: Tool[] = [];

/** A ContextSource that reports no usage and a large window, so auto-compact
 * is a no-op (the Session test only exercises the turn path). */
const noopContext: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  async contextMax() {
    return { ok: true, value: 100_000 };
  },
};

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
    const result = await runTurn(client, noopTools, messages, noToolDefs, (t) =>
      seen.push(t),
    );
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
                { id: "call_1", function: { name: "noop", arguments: "{}" } },
              ],
            },
          };
        }
        return { ok: true, value: { content: "done" } };
      },
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    const result = await runTurn(client, noopTools, messages, noToolDefs, (t) =>
      seen.push(t),
    );
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("done");
    // Two rounds, two "thinking"+"..." deltas each → 4 total.
    expect(seen).toEqual(["thinking", "...", "thinking", "..."]);
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

describe("Session streaming flag (core)", () => {
  test("sets streamed=true on a successful turn when onToken is provided", async () => {
    const client: Client = {
      async chat() {
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      onToken: () => {},
    });
    const result = await session.handleLine("hi");
    expect(result).not.toBe("exit");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.streamed).toBe(true);
  });

  test("does not set streamed when onToken is absent", async () => {
    const client: Client = {
      async chat() {
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    const result = await session.handleLine("hi");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.streamed).toBeFalse();
  });
});
