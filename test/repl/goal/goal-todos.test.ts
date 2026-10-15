import { expect, test } from "bun:test";
import type { Client, Message } from "@vise/core";
import { GoalTracker } from "../../../packages/backend/src/repl/turn/goal-loop.ts";

/** A client that derives one goal, then answers every goal check with "yes". */
function yesClient(asked: string[]): Client {
  return {
    chat: async (messages) => {
      const question = messages.at(-1)?.content ?? "";
      if (question.startsWith("[goal tracking")) {
        asked.push(question);
        return { ok: true, value: { content: '{"goal":"g","done_when":"d","hold":""}' } };
      }
      return { ok: true, value: { content: '{"verdict":"yes","detail":"all done"}' } };
    },
  };
}

test("a met goal does not end the turn while the todo list has unfinished items", async () => {
  const open = ["Phase 1", "Phase 2"];
  let turns = 0;
  const messages: Message[] = [{ role: "user", content: "do the plan" }];
  const tracker = new GoalTracker(true);
  const result = await tracker.run(
    yesClient([]),
    messages,
    [],
    async () => {
      turns++;
      // Each continue finishes one item.
      if (turns > 1) open.shift();
      return { ok: true, value: "done" };
    },
    new AbortController().signal,
    { openTodos: () => [...open] },
  );
  expect(result.ok).toBe(true);
  // first turn + one continue per remaining item
  expect(turns).toBe(3);
  expect(open).toEqual([]);
  expect(messages.some((m) => m.content.includes("todo list still has"))).toBe(true);
});

test("the goal is derived from `said` when the request is not yet in the conversation", async () => {
  const asked: string[] = [];
  const tracker = new GoalTracker(true);
  await tracker.run(
    yesClient(asked),
    [{ role: "user", content: "an earlier message about bananas" }],
    [],
    async () => ({ ok: true, value: "done" }),
    new AbortController().signal,
    { said: "Run workflow 'implement'. User request: the plan" },
  );
  expect(asked[0]).toContain("Run workflow 'implement'");
  expect(asked[0]).not.toContain("bananas");
});
