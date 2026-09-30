import { describe, test, expect } from "bun:test";
import { runSubagent } from "../src/core/engine.ts";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import type { Message } from "../src/core/errors.ts";

const noopTools: ToolRunner = {
  async run(_name, _args) {
    return "tool output";
  },
};

const noToolDefs: Tool[] = [];

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
