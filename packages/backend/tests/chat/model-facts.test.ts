import { describe, expect, test } from "bun:test";
import type { ModelSummary } from "common";
import { estimateTokens } from "common";
import { buildModelSelf } from "../../src/chat/model-facts";
import { toolDefinitions } from "../../src/tools";

const info: ModelSummary = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  contextLength: 128_000,
  promptPricePerMillion: null,
  completionPricePerMillion: null,
};

const upstream = [
  { role: "system" as const, content: "The working directory is /root." },
  { role: "user" as const, content: "hi" },
];

describe("buildModelSelf", () => {
  test("the budget left counts the system context and the tool definitions", () => {
    const limit = 100_000;
    const self = buildModelSelf(info, upstream, toolDefinitions, limit);
    const carried =
      estimateTokens(JSON.stringify(upstream)) +
      estimateTokens(JSON.stringify(toolDefinitions));
    expect(self.remainingBudgetTokens).toBe(limit - carried);
    // Counting only the chat text would leave more room than the request really has.
    expect(self.remainingBudgetTokens).toBeLessThan(
      limit - estimateTokens("hi"),
    );
  });

  test("the budget left is clamped to 0 when the conversation is over the limit", () => {
    const huge = [{ role: "user" as const, content: "x".repeat(10_000) }];
    const self = buildModelSelf(info, huge, [], 10);
    expect(self.remainingBudgetTokens).toBe(0);
  });

  test("toolNames lists the tools offered, and is empty when none are offered", () => {
    expect(
      buildModelSelf(info, upstream, toolDefinitions, 100_000).toolNames,
    ).toEqual(toolDefinitions.map((tool) => tool.function.name));
    expect(buildModelSelf(info, upstream, [], 100_000).toolNames).toEqual([]);
  });
});
