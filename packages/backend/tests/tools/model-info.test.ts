import { describe, expect, test } from "bun:test";
import { runTool } from "../../src/tools";
import type { ModelSelf } from "../../src/tools/model-info";

const self: ModelSelf = {
  id: "openai/gpt-4o",
  name: "GPT-4o",
  contextLength: 128_000,
  replyReserveTokens: 4_000,
  remainingBudgetTokens: 100_000,
  toolNames: ["get_model_info", "list_directory"],
};

describe("get_model_info", () => {
  test("reports the facts about the model answering the reply", async () => {
    const text = await runTool("/root", "get_model_info", "{}", self);
    expect(text).toBe(JSON.stringify(self, null, 2));
  });

  test("says so when the backend has no facts for the reply", async () => {
    const text = await runTool("/root", "get_model_info", "{}");
    expect(text).toBe("Model information is not available for this reply.");
  });
});
