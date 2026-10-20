import { expect, test } from "bun:test";
import type { Client } from "@vise/core";
import type { CallPurpose, ViseError } from "@vise/core";
import { checkGoal, checkProgress, deriveGoal } from "@vise/core";
import { summarize } from "@vise/core";

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
  await checkGoal(labelling('{"verdict":"yes","detail":"d"}', purposes), [], [], goal);
  await checkProgress(labelling('{"progress":"progressing","detail":"d"}', purposes), [], [], goal);
  await summarize(labelling("summary", purposes), [{ role: "user", content: "x" }]);
  expect(purposes).toEqual(["goal", "goal-check", "progress-check", "compaction"]);
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

test("the reason names the failure: a network error, an HTTP error, a reply in another shape", async () => {
  const failing = (error: ViseError): Client => ({
    chat: async () => ({ ok: false, error }),
  });
  const goal = { text: "g", doneWhen: "d" };
  const net = await checkGoal(failing({ kind: "network", cause: "socket closed" }), [], [], goal);
  expect(net).toEqual({
    kind: "unknown",
    detail: "the connection to the model failed: socket closed",
  });
  const http = await checkGoal(
    failing({ kind: "http", status: 503, body: "loading model" }),
    [],
    [],
    goal,
  );
  expect(http.detail).toBe("the server answered HTTP 503: loading model");
  const text: Client = {
    chat: async () => ({ ok: true, value: { content: "sure!" } }),
  };
  expect((await checkGoal(text, [], [], goal)).detail).toBe(
    `the reply did not match the response schema (reply: sure!)`,
  );
});

test("a reply in another shape (an unconstrained server) is asked again", async () => {
  let calls = 0;
  const client: Client = {
    chat: async () => {
      calls++;
      const content =
        calls === 1
          ? '{"name":"read_file","arguments":{"path":"a"}}'
          : '{"verdict":"maybe","detail":"x"}';
      return {
        ok: true,
        value: { content: calls === 3 ? '{"verdict":"yes","detail":"done"}' : content },
      };
    },
  };
  const verdict = await checkGoal(client, [], [], { text: "g", doneWhen: "d" });
  expect(verdict).toEqual({ kind: "yes", detail: "done" });
  expect(calls).toBe(3);
});
