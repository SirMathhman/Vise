import { describe, test, expect } from "bun:test";
import { runTurn } from "../src/core/engine.ts";
import type {
  Client,
  Tool,
  ToolRunner,
} from "../src/core/engine.ts";
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
    const result = await runTurn(client, noopTools, messages, noToolDefs, (t) =>
      seen.push(t),
    );
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("done");
    // Two rounds, two "thinking"+"..." deltas each → 4 total.
    expect(seen).toEqual(["thinking", "...", "thinking", "..."]);
  });
});
