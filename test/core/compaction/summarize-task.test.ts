import { expect, test } from "bun:test";
import { summarize, type Client, type Message } from "@vise/core";

test("the summary request quotes what the user typed, so the task is not guessed", async () => {
  let ask = "";
  const client: Client = {
    chat: async (messages) => {
      ask = messages[messages.length - 1]?.content ?? "";
      return { ok: true, value: { content: "summary" } };
    },
  };
  const body: Message[] = [
    { role: "user", content: "You are a helpful assistant." },
    { role: "user", content: "Update AGENTS.md.", typed: true },
  ];
  await summarize(client, body);
  expect(ask).toContain("Update AGENTS.md.");
});
