import { expect, test } from "bun:test";
import type { Client } from "../../src/core/engine.ts";
import type { CallPurpose } from "../../src/core/errors.ts";
import { checkGoal, checkProgress, deriveGoal } from "../../src/core/goal.ts";
import { summarize } from "../../src/core/engine.ts";

/** A client that records what each labelled call was for. */
function labelling(reply: string, purposes: CallPurpose[]): Client {
  const chat: Client["chat"] = async () => ({
    ok: true,
    value: { content: reply },
  });
  return {
    chat,
    as: (purpose) => {
      purposes.push(purpose);
      return { chat };
    },
  };
}

test("each model call says what it is for, so its prompt processing can be labelled", async () => {
  const purposes: CallPurpose[] = [];
  const goal = { text: "do it", doneWhen: "it is done" };
  await deriveGoal(
    labelling('{"goal":"g","done_when":"d"}', purposes),
    [{ role: "user", content: "x" }],
    [],
    undefined,
  );
  await checkGoal(
    labelling('{"verdict":"yes","detail":"d"}', purposes),
    [],
    [],
    goal,
  );
  await checkProgress(
    labelling('{"progress":"progressing","detail":"d"}', purposes),
    [],
    [],
    goal,
  );
  await summarize(labelling("summary", purposes), [
    { role: "user", content: "x" },
  ]);
  expect(purposes).toEqual([
    "goal",
    "goal-check",
    "progress-check",
    "compaction",
  ]);
});

test("a client that does not label is simply used as it is", async () => {
  const plain: Client = {
    chat: async () => ({ ok: true, value: { content: "summary" } }),
  };
  const result = await summarize(plain, [{ role: "user", content: "x" }]);
  expect(result).toEqual({ ok: true, value: "summary" });
});

test("a goal check that fails on the network is asked again instead of counting as met", async () => {
  let calls = 0;
  const client: Client = {
    chat: async () => {
      calls++;
      return calls < 3
        ? { ok: false, error: { kind: "network", cause: "socket closed" } }
        : { ok: true, value: { content: '{"verdict":"no","detail":"next"}' } };
    },
  };
  const verdict = await checkGoal(client, [], [], { text: "g", doneWhen: "d" });
  expect(verdict).toEqual({ kind: "no", detail: "next" });
  expect(calls).toBe(3);
});

test("a goal check that answers in the wrong shape is asked again", async () => {
  const replies = [
    "{}",
    '{"verdict":"maybe","detail":""}',
    "[]",
    '{"verdict":"blocked","detail":"need login"}',
  ];
  let calls = 0;
  const client: Client = {
    chat: async () => ({
      ok: true,
      value: { content: replies[calls++] ?? "" },
    }),
  };
  const verdict = await checkGoal(client, [], [], { text: "g", doneWhen: "d" });
  expect(calls).toBe(3);
  expect(verdict.kind).toBe("yes"); // out of attempts: fails open
});
