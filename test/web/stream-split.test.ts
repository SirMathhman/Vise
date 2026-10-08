import { expect, test } from "bun:test";
import { MIN_FROZEN, stableCut } from "../../web/src/transcript/stream-split.ts";

const para = (n: number): string => `paragraph ${n} ${"word ".repeat(40)}\n\n`;
const long = (count: number): string =>
  Array.from({ length: count }, (_, i) => para(i)).join("");

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

import { createCutScanner } from "../../web/src/transcript/stream-split.ts";

test("a fence is closed only by the same character at least as long", () => {
  const before = long(8);
  const open = `${before}\`\`\`\`md\nexample:\n\n\`\`\`ts\ninner\n\`\`\`\n\nstill inside the outer fence\n\n`;
  expect(stableCut(open)).toBe(before.length);
  const tilde = `${before}~~~\ntext\n\n\`\`\`\nnot a closer\n\n`;
  expect(stableCut(tilde)).toBe(before.length);
});

test("a blank line inside a list is not a cut point; the next plain paragraph is", () => {
  const before = long(8);
  const list = `${before}- one\n\n- two\n\n- three\n\n`;
  expect(stableCut(`${list}`)).toBe(before.length);
  expect(stableCut(`${list}A new paragraph.\n`)).toBe(list.length);
});

test("a reply with reference links or raw HTML is left to the final render", () => {
  const withRef = `${long(4)}[docs]: https://example.com\n\n${long(6)}`;
  expect(stableCut(withRef)).toBeLessThanOrEqual(long(4).length);
  const withHtml = `${long(4)}<details>\n\ninner\n\n</details>\n\n${long(6)}`;
  expect(stableCut(withHtml)).toBeLessThanOrEqual(long(4).length);
});

test("scanning as the text grows gives the same cut as scanning it whole", () => {
  const full = `${long(10)}\`\`\`ts\na\n\nb\n\`\`\`\n\n- x\n\n- y\n\nlast paragraph here and more\n\n${long(3)}`;
  const scan = createCutScanner();
  for (let end = 1; end < full.length; end += 53) scan(full.slice(0, end));
  expect(scan(full)).toBe(stableCut(full));
});
