import { describe, expect, test } from "bun:test";
import { cyan, dim, red } from "../../packages/backend/src/output/color.ts";

/**
 * Run `fn` with the given env vars set, restoring the original values
 * afterward. `isEnabled()` in `color.ts` reads `process.env` per call, so the
 * color helpers are deterministic under these overrides.
 */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe("color", () => {
  test("emits ANSI codes when FORCE_COLOR is set", () => {
    withEnv({ FORCE_COLOR: "1" }, () => {
      expect(red("x")).toBe("\x1b[1;31mx\x1b[0m");
      expect(dim("x")).toBe("\x1b[2mx\x1b[0m");
      expect(cyan("x")).toBe("\x1b[36mx\x1b[0m");
    });
  });

  test("returns plain text when NO_COLOR is set and FORCE_COLOR is not", () => {
    withEnv({ NO_COLOR: "1", FORCE_COLOR: undefined }, () => {
      expect(red("x")).toBe("x");
      expect(dim("x")).toBe("x");
      expect(cyan("x")).toBe("x");
    });
  });
});
