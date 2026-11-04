import { expect, test } from "bun:test";
import { needsCompaction } from "./compaction.ts";

test("compacts once the last prompt reaches 80% of the context window", () => {
  expect(needsCompaction(79, 100)).toBe(false);
  expect(needsCompaction(80, 100)).toBe(true);
});
