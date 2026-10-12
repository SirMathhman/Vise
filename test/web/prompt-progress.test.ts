import { expect, test } from "bun:test";
import { describeCall, readCall } from "@vise/core";
import { describeProgress, startsNewBar } from "../../packages/frontend/src/status/prompt-progress.ts";

test("a call reports only the tokens it has to read, not the cached conversation", () => {
  const reading = readCall({
    total: 1000,
    cache: 400,
    processed: 700,
    time_ms: 900,
  });
  expect(reading).toEqual({
    name: "prompt",
    total: 600,
    done: 300,
    reused: 400,
    finished: false,
  });
  expect(
    describeCall({ total: 1000, cache: 400, processed: 700, time_ms: 900 }),
  ).toBe("prompt: 300/600 tokens · 400 reused");
});

test("a finished call is a summary of what it read, with the time", () => {
  expect(
    describeCall({ total: 1000, cache: 0, processed: 1000, time_ms: 2500 }),
  ).toBe("prompt: 1000 tokens · 2.5 s");
  // A prompt that was all but cached shows how little was new, not how long the conversation is.
  expect(
    describeCall({
      total: 57733,
      cache: 57728,
      processed: 57733,
      time_ms: 500,
    }),
  ).toBe("prompt: 5 tokens · 57728 reused · 0.5 s");
});

test("each call says what it is for", () => {
  const base = { total: 100, cache: 0, processed: 10, time_ms: 0 };
  expect(describeCall({ ...base, purpose: "goal" })).toBe(
    "goal: 10/100 tokens",
  );
  expect(describeCall({ ...base, purpose: "goal-check" })).toBe(
    "goal check: 10/100 tokens",
  );
  expect(describeCall({ ...base, purpose: "compaction" })).toBe(
    "compaction: 10/100 tokens",
  );
});

test("odd numbers are kept inside the bar, and no prompt size means nothing to draw", () => {
  const view = describeProgress({ total: 100, cache: 500, processed: 50 });
  expect(view?.pct).toBeGreaterThanOrEqual(0);
  expect(view?.pct).toBeLessThanOrEqual(100);
  expect(describeProgress({ total: 0, processed: 0 })).toBeUndefined();
  expect(describeProgress({ processed: 10 })).toBeUndefined();
});

test("the bar fills over the new tokens only", () => {
  const view = describeProgress({
    total: 1000,
    cache: 400,
    processed: 700,
    time_ms: 0,
  });
  expect(view).toMatchObject({ done: false, pct: 50 });
});

test("a new request, or a cleared log, starts a new bar; the same request keeps its bar", () => {
  expect(startsNewBar(null, 1)).toBe(true);
  expect(startsNewBar({ request: 1, attached: true }, 1)).toBe(false);
  // A cut-short request followed by another, whatever its first count is.
  expect(startsNewBar({ request: 1, attached: true }, 2)).toBe(true);
  // /new or a resume emptied the log and removed the old line.
  expect(startsNewBar({ request: 1, attached: false }, 1)).toBe(true);
});
