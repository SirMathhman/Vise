import { expect, test } from "bun:test";
import { historyMessages } from "../core/sessions.ts";

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
