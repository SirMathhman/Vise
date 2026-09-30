import { describe, test, expect } from "bun:test";
import type {
  Client,
  Tool,
  ToolRunner,
} from "../src/core/engine.ts";
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
