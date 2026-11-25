import { describe, expect, test } from "bun:test";
import type { ChatMessage } from "./index";
import { SUMMARY_PREFIX, compactConversation } from "./index";

describe("compactConversation", () => {
  test("starts with the new summary and keeps the most recent messages", () => {
    const history: ChatMessage[] = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ];
    expect(compactConversation(history, "S", 2)).toEqual([
      { role: "user", content: `${SUMMARY_PREFIX}S` },
      { role: "assistant", content: "two" },
      { role: "user", content: "three" },
    ]);
  });

  test("drops an earlier summary instead of keeping it", () => {
    const history: ChatMessage[] = [
      { role: "user", content: `${SUMMARY_PREFIX}old` },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ];
    expect(compactConversation(history, "new", 10)).toEqual([
      { role: "user", content: `${SUMMARY_PREFIX}new` },
      { role: "user", content: "one" },
      { role: "assistant", content: "two" },
    ]);
  });
});
