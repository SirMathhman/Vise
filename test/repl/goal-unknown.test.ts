import { expect, test } from "bun:test";
import type { Client } from "@vise/core";
import { type GoalEvent, GoalTracker } from "../../src/repl/turn/goal-loop.ts";

test("when the goal check cannot be made the turn ends, the reason is shown and the goal is kept", async () => {
  let calls = 0;
  const client: Client = {
    // the first call derives the goal; every later one (the check) fails
    chat: async () =>
      calls++ === 0
        ? { ok: true, value: { content: '{"goal":"g","done_when":"d"}' } }
        : { ok: false, error: { kind: "network", cause: "socket closed" } },
  };
  const events: GoalEvent[] = [];
  const tracker = new GoalTracker(true, (e) => events.push(e));
  const result = await tracker.run(
    client,
    [{ role: "user", content: "do it" }],
    [],
    async () => ({ ok: true, value: "done" }),
    new AbortController().signal,
  );
  expect(result.ok).toBe(true);
  expect(tracker.goal?.text).toBe("g");
  expect(events.at(-1)).toEqual({
    kind: "verdict",
    verdict: "unknown",
    detail: "the connection to the model failed: socket closed",
    continuing: false,
  });
});
