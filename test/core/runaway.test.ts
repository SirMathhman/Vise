import { describe, expect, test } from "bun:test";
import { repeatedSentence, repetition, runawayVerdict } from "@vise/core";

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

describe("repeatedSentence", () => {
  const sentence = "I have a good picture now. Let me clarify a few remaining design details before writing the plan.";
  const last = "Let me clarify a few remaining design details before writing the plan.";

  test("the same sentence four times in a row is a loop", () => {
    const text = `${sentence}\n${last}\n\n${last}\n\n${last}\n`;
    expect(repeatedSentence(text)).toMatchObject({ period: last.length, repeats: 4 });
    expect(runawayVerdict({ tokens: 0, cap: 0, tail: text, loopGuard: true, sentences: true }).stop).toBe(true);
    // Not judged unless asked (reasoning repeats legitimately).
    expect(runawayVerdict({ tokens: 0, cap: 0, tail: text, loopGuard: true }).stop).toBe(false);
  });

  test("three times, short lines, lists and tool calls are not", () => {
    expect(repeatedSentence(`${last}\n${last}\n${last}`)).toBeUndefined();
    expect(repeatedSentence("  },\n".repeat(10))).toBeUndefined();
    expect(repeatedSentence(Array.from({ length: 6 }, (_, i) => `${i}. ${last}`).join("\n"))).toBeUndefined();
    const call = `<tool_call>\n${(last + "\n").repeat(6)}`;
    expect(repeatedSentence(call)).toBeUndefined();
  });

  test("text before a finished tool call does not count", () => {
    const text = `${(last + "\n").repeat(5)}<tool_call>{"name":"x"}</tool_call>\nDone.`;
    expect(repeatedSentence(text)).toBeUndefined();
  });
});
