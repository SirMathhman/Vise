import { expect, test } from "bun:test";
import { describeProgress, startsNewBar } from "../web/src/prompt-progress.ts";

test("a running report shows how far the prompt is read, with the cached part first", () => {
  const view = describeProgress({ total: 1000, cache: 400, processed: 700, time_ms: 900 });
  expect(view).toMatchObject({ done: false, cachedPct: 40, computedPct: 30, valueNow: 70 });
  expect(view?.text).toBe("prompt 700/1000 · 400 cached");
});

test("a finished report is a summary with the time", () => {
  const view = describeProgress({ total: 1000, cache: 0, processed: 1000, time_ms: 2500 });
  expect(view?.done).toBe(true);
  expect(view?.text).toBe("prompt 1000 tokens · 2.5 s");
});

test("odd numbers are kept inside the bar, and no prompt size means nothing to draw", () => {
  const view = describeProgress({ total: 100, cache: 500, processed: 50 });
  expect(view?.cachedPct).toBe(50);
  expect(view?.computedPct).toBe(0);
  expect(describeProgress({ total: 0, processed: 0 })).toBeUndefined();
  expect(describeProgress({ processed: 10 })).toBeUndefined();
});

test("a new request, or a cleared log, starts a new bar; the same request keeps its bar", () => {
  expect(startsNewBar(null, 1)).toBe(true);
  expect(startsNewBar({ request: 1, attached: true }, 1)).toBe(false);
  // A cut-short request followed by another, whatever its first count is.
  expect(startsNewBar({ request: 1, attached: true }, 2)).toBe(true);
  // /new or a resume emptied the log and removed the old line.
  expect(startsNewBar({ request: 1, attached: false }, 1)).toBe(true);
});
