import { expect, mock, test } from "bun:test";
import { contextLabel } from "../../../packages/frontend/src/models/model-picker.ts";

test("a context window is shown rounded, in K or M tokens", () => {
  expect(contextLabel(8_000)).toBe("8K ctx");
  expect(contextLabel(131_072)).toBe("131K ctx");
  expect(contextLabel(1_000_000)).toBe("1M ctx");
  expect(contextLabel(1_500_000)).toBe("1.5M ctx");
});

// Mock the storage module so readRecent can be exercised against controlled values.
mock.module(
  "../../../packages/frontend/src/storage.ts",
  () => ({
    storage: {
      get: () => (globalThis as Record<string, unknown>).__recentValue ?? null,
      set: () => {},
      remove: () => {},
    },
  }),
);

import { readRecent } from "../../../packages/frontend/src/models/model-picker.ts";

test("readRecent returns [] when storage is empty", () => {
  (globalThis as Record<string, unknown>).__recentValue = null;
  expect(readRecent()).toEqual([]);
});

test("readRecent returns [] for a non-array value", () => {
  (globalThis as Record<string, unknown>).__recentValue = `"hello"`;
  expect(readRecent()).toEqual([]);
});

test("readRecent returns [] for an array with non-string entries", () => {
  (globalThis as Record<string, unknown>).__recentValue = JSON.stringify(["valid", 42]);
  expect(readRecent()).toEqual([]);
});

test("readRecent returns the array for a valid string array", () => {
  (globalThis as Record<string, unknown>).__recentValue = JSON.stringify(["a", "b", "c"]);
  expect(readRecent()).toEqual(["a", "b", "c"]);
});
