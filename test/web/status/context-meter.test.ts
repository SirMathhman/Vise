import { describe, expect, test } from "bun:test";
import { compactCount, parseContextFill } from "../../../packages/frontend/src/status/context-meter.ts";

describe("context meter", () => {
  test("reads the server's context report", () => {
    expect(parseContextFill("context: 12345 / 141568 tokens (8.72%)")).toEqual({
      used: 12345,
      max: 141568,
      percent: 8.72,
    });
    expect(parseContextFill("context: 0 / 141568 tokens (0%)")?.percent).toBe(0);
    expect(parseContextFill("no numbers here")).toBeUndefined();
  });

  test("counts are shortened", () => {
    expect(compactCount(950)).toBe("950");
    expect(compactCount(1500)).toBe("1.5k");
    expect(compactCount(12345)).toBe("12.3k");
    expect(compactCount(141568)).toBe("141.6k");
    expect(compactCount(2_000_000)).toBe("2M");
  });
});
