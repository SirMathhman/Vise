import { expect, test } from "bun:test";
import { inlineParts, markdownBlocks } from "./markdown.ts";

test("headings, paragraphs joined over soft breaks, and blank-line separation", () => {
  expect(markdownBlocks("# Title\nfirst line\nsecond line\n\nnext")).toEqual([
    { kind: "heading", level: 1, text: "Title" },
    { kind: "paragraph", text: "first line second line" },
    { kind: "paragraph", text: "next" },
  ]);
});

test("Windows line endings give the same blocks as Unix ones", () => {
  expect(markdownBlocks("# Title\r\nfirst\r\n\r\nnext")).toEqual(markdownBlocks("# Title\nfirst\n\nnext"));
  expect(markdownBlocks("# Title\r\n")[0]).toEqual({ kind: "heading", level: 1, text: "Title" });
});

test("bulleted and numbered lists, each run as one list", () => {
  expect(markdownBlocks("- a\n* b\n1. c\n2) d")).toEqual([
    { kind: "list", ordered: false, items: ["a", "b"] },
    { kind: "list", ordered: true, items: ["c", "d"] },
  ]);
});

test("a fenced block keeps its lines as text, including markdown-looking ones", () => {
  expect(markdownBlocks("```\n# not a heading\n- not a list\n```\nafter")).toEqual([
    { kind: "code", text: "# not a heading\n- not a list" },
    { kind: "paragraph", text: "after" },
  ]);
});

test("an unclosed fence runs to the end of the text", () => {
  expect(markdownBlocks("```\nline")).toEqual([{ kind: "code", text: "line" }]);
});

test("inline code, strong, emphasis, and a link shown as its text", () => {
  expect(inlineParts("a `b*c` **d** *e* [f](https://x.test) g")).toEqual([
    { kind: "text", text: "a " },
    { kind: "code", text: "b*c" },
    { kind: "text", text: " " },
    { kind: "strong", text: "d" },
    { kind: "text", text: " " },
    { kind: "em", text: "e" },
    { kind: "text", text: " " },
    { kind: "text", text: "f" },
    { kind: "text", text: " g" },
  ]);
});

test("markup in model text stays text, with no tags produced", () => {
  expect(inlineParts("<img src=x onerror=alert(1)>")).toEqual([
    { kind: "text", text: "<img src=x onerror=alert(1)>" },
  ]);
});
