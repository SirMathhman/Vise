import { expect, test } from "bun:test";
import { historyMessages } from "../core/sessions.ts";
import { withInstructions } from "../core/messages.ts";

test("the instructions sent ahead of the first message are not shown as part of it", () => {
  const history = [
    { role: "user" as const, content: "AGENTS TEXT\n\nhello" },
    { role: "assistant" as const, content: "hi" },
  ];
  expect(historyMessages(history, "AGENTS TEXT")).toEqual([
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi" },
  ]);
  expect(historyMessages(history)).toEqual([
    { role: "user", text: "AGENTS TEXT\n\nhello" },
    { role: "assistant", text: "hi" },
  ]);
});

test("a request carries the instructions in front of its first message, once, and the stored history is not changed", () => {
  const stored = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "hi" },
  ];
  expect(withInstructions(stored, "AGENTS TEXT")).toEqual([
    { role: "user", content: "AGENTS TEXT\n\nhello" },
    { role: "assistant", content: "hi" },
  ]);
  expect(stored[0]).toEqual({ role: "user", content: "hello" });
  const legacy = [{ role: "user" as const, content: "AGENTS TEXT\n\nhello" }];
  expect(withInstructions(legacy, "AGENTS TEXT")).toEqual(legacy);
  expect(withInstructions(stored, undefined)).toBe(stored);
});
