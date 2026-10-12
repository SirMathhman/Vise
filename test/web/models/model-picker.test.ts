import { expect, test } from "bun:test";
import { contextLabel } from "../../../packages/frontend/src/models/model-picker.ts";

test("a context window is shown rounded, in K or M tokens", () => {
  expect(contextLabel(8_000)).toBe("8K ctx");
  expect(contextLabel(131_072)).toBe("131K ctx");
  expect(contextLabel(1_000_000)).toBe("1M ctx");
  expect(contextLabel(1_500_000)).toBe("1.5M ctx");
});
