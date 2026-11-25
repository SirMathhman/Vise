import { describe, expect, test } from "bun:test";
import { readRange } from "./read-file";

const text = "one\ntwo\nthree\nfour";

describe("readRange", () => {
  test("returns the whole file when no range is given", () => {
    expect(readRange(text, 1, undefined)).toBe(
      "Lines 1-4 of 4:\none\ntwo\nthree\nfour",
    );
  });

  test("returns only the requested lines, inclusive", () => {
    expect(readRange(text, 2, 3)).toBe("Lines 2-3 of 4:\ntwo\nthree");
  });

  test("refuses a start past the end and an end before the start", () => {
    expect(readRange(text, 9, undefined)).toBe(
      "The file has 4 lines; start_line 9 is past the end.",
    );
    expect(readRange(text, 3, 2)).toBe(
      "end_line must not be before start_line.",
    );
  });

  test("cuts text longer than the limit and says so", () => {
    const long = "x".repeat(25000);
    const result = readRange(long, 1, undefined);
    expect(result).toContain("... cut; read a smaller line range to see more");
    expect(result.length).toBeLessThan(20100);
  });
});
