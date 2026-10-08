import { expect, test } from "bun:test";
import type { Client } from "../src/core/engine.ts";
import type { PromptProgress } from "../src/core/errors.ts";
import { checkGoal, checkProgress, deriveGoal } from "../src/core/goal.ts";

/** A client that reports one chunk of prompt processing, as llama.cpp does while it reads the prompt. */
function reportingClient(reply: string): Client {
  return {
    async chat(_messages, _tools, _onToken, _onThinking, onPromptProgress) {
      onPromptProgress?.({ total: 100, cache: 0, processed: 40, time_ms: 5 });
      return { ok: true, value: { content: reply } };
    },
  };
}

test("the goal's own model calls report their prompt processing, so a long wait is visible", async () => {
  const seen: PromptProgress[] = [];
  const onProgress = (p: PromptProgress): void => void seen.push(p);
  const goal = { text: "do it", doneWhen: "it is done" };
  await deriveGoal(
    reportingClient('{"goal":"do it","done_when":"done"}'),
    [{ role: "user", content: "do it" }],
    [],
    undefined,
    undefined,
    undefined,
    onProgress,
  );
  await checkGoal(reportingClient('{"verdict":"yes","detail":"d"}'), [], [], goal, undefined, onProgress);
  await checkProgress(
    reportingClient('{"progress":"progressing","detail":"d"}'),
    [],
    [],
    goal,
    undefined,
    onProgress,
  );
  expect(seen).toHaveLength(3);
  expect(seen[0]).toMatchObject({ total: 100, processed: 40 });
});
