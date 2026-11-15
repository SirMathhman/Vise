import { expect, test } from "bun:test";
import { maxRoundsOf } from "./start-options.ts";

test("the round cap is absent unless --max-rounds names a whole number of at least 1", () => {
  expect(maxRoundsOf(["--unattended"])).toEqual({ ok: true, value: undefined });
  expect(maxRoundsOf(["--max-rounds", "5"])).toEqual({ ok: true, value: 5 });
  expect(maxRoundsOf(["--max-rounds=7"])).toEqual({ ok: true, value: 7 });
  expect(maxRoundsOf(["--max-rounds", "0"]).ok).toBe(false);
  expect(maxRoundsOf(["--max-rounds", "1.5"]).ok).toBe(false);
  expect(maxRoundsOf(["--max-rounds"]).ok).toBe(false);
  expect(maxRoundsOf(["--max-rounds=abc"]).ok).toBe(false);
});
