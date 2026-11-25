import { parseJson } from "common";
import { z } from "zod";
import { describe, expect, test } from "bun:test";
import { runTool } from "../../src/tools";
import type { ModelSelf } from "../../src/chat/model-facts";

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
    const text = await runTool({ root: "/root", self }, "get_model_info", "{}");
    expect(text).toBe(JSON.stringify(self, null, 2));
  });

  test("says so when the backend has no facts for the reply", async () => {
    const text = await runTool({ root: "/root" }, "get_model_info", "{}");
    expect(text).toBe("Model information is not available for this reply.");
  });
});

describe("get_model_info output shape", () => {
  test("the output is a JSON object with exactly the ModelSelf keys", async () => {
    const text = await runTool({ root: "/root", self }, "get_model_info", "{}");
    if (typeof text !== "string") {
      throw new Error("get_model_info should return text, not an approval");
    }
    const parsed = parseJson(z.record(z.string(), z.unknown()), text);
    if (!parsed.ok) {
      throw new Error("the output is not a JSON object");
    }
    expect(Object.keys(parsed.value).sort()).toEqual(
      [
        "contextLength",
        "id",
        "name",
        "remainingBudgetTokens",
        "replyReserveTokens",
        "toolNames",
      ].sort(),
    );
  });
});
