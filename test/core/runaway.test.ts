import { describe, expect, test } from "bun:test";
import { repetition, runawayVerdict } from "../../src/core/call/runaway.ts";

const loopText = "I will now ask the user which option they prefer. ".repeat(60);
const prose = Array.from(
  { length: 80 },
  (_, i) => `Sentence number ${i} talks about topic ${(i * 7919) % 101} in some detail.`,
).join(" ");

describe("repetition", () => {
  test("finds the chunk a text keeps repeating", () => {
    const found = repetition(loopText);
    expect(found).toBeDefined();
    expect(found?.period).toBe(50);
    expect(found?.repeats).toBeGreaterThanOrEqual(8);
  });

  test("a loop is found even after normal text before it", () => {
    expect(repetition(prose + loopText)?.period).toBe(50);
  });

  test("a loop with a stray difference still counts", () => {
    let n = 0;
    const noisy = loopText.replace(/option/g, (m) => (n++ % 10 === 0 ? "optiom" : m));
    expect(repetition(noisy)).toBeDefined();
  });

  test("ordinary prose, code and short texts do not", () => {
    expect(repetition(prose)).toBeUndefined();
    expect(repetition("short")).toBeUndefined();
    const code = Array.from({ length: 60 }, (_, i) => `function f${i}(a, b) { return a * ${i} + b; }`).join("\n");
    expect(repetition(code)).toBeUndefined();
  });
});

describe("runawayVerdict", () => {
  const base = { tokens: 100, cap: 1000, tail: prose, loopGuard: true };

  test("a normal call is left alone", () => {
    expect(runawayVerdict(base)).toEqual({ stop: false });
  });

  test("the token cap stops a call, and 0 means no cap", () => {
    const over = runawayVerdict({ ...base, tokens: 1001 });
    expect(over).toMatchObject({ stop: true, reason: "token_cap" });
    expect(runawayVerdict({ ...base, tokens: 10_000_000, cap: 0 })).toEqual({ stop: false });
  });

  test("a loop stops a call unless the guard is off", () => {
    const loop = runawayVerdict({ ...base, tail: loopText });
    expect(loop).toMatchObject({ stop: true, reason: "loop" });
    expect(runawayVerdict({ ...base, tail: loopText, loopGuard: false })).toEqual({ stop: false });
  });
});
