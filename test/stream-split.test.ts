import { expect, test } from "bun:test";
import { MIN_FROZEN, stableCut } from "../web/src/stream-split.ts";

const para = (n: number): string => `paragraph ${n} ${"word ".repeat(40)}\n\n`;
const long = (count: number): string => Array.from({ length: count }, (_, i) => para(i)).join("");

test("a short reply is never split", () => {
  expect(stableCut("hello\n\nworld\n\n")).toBe(0);
});

test("a long reply is cut after its last blank line, and the open last line stays in the tail", () => {
  const text = long(12);
  expect(text.length).toBeGreaterThan(MIN_FROZEN);
  const open = `${text}still being wr`;
  expect(stableCut(open)).toBe(text.length);
  expect(open.slice(stableCut(open))).toBe("still being wr");
});

test("blank lines inside a code fence are not cut points", () => {
  const before = long(8);
  const text = `${before}\`\`\`ts\nconst a = 1;\n\nconst b = 2;\n\nconst c = 3;\n`;
  expect(stableCut(text)).toBe(before.length);
  expect(stableCut(`${text}\`\`\`\n\nafter\n`)).toBeGreaterThan(before.length);
});

test("the cut never moves back as the reply grows", () => {
  let previous = 0;
  const full = `${long(10)}\`\`\`\nx\n\ny\n\`\`\`\n\n${long(3)}`;
  for (let end = 0; end <= full.length; end += 37) {
    const cut = stableCut(full.slice(0, end));
    expect(cut).toBeGreaterThanOrEqual(previous);
    previous = cut;
  }
});
