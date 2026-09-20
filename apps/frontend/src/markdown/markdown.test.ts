import { MAX_BLOCK_DEPTH } from "./blocks.js";
import { safeHref } from "./dom.js";
import { parseMarkdown } from "./index.js";
import type { Block, Inline } from "./types.js";

const BS = String.fromCharCode(92); // a single backslash

/** The inline children of the first block, which must be a paragraph. */
function para(md: string): Inline[] {
  const b = parseMarkdown(md)[0];
  if (b.t !== "p") throw new Error(`expected a paragraph, got ${b.t}`);
  return b.c;
}

/** How deeply blocks nest (lists and quotes), following the first child. */
function depthOf(blocks: Block[]): number {
  const b = blocks[0];
  if (!b) return 0;
  if (b.t === "quote") return 1 + depthOf(b.c);
  if (b.t === "list") return 1 + depthOf(b.items[0] ?? []);
  return 0;
}

describe("markdown blocks", () => {
  it("splits paragraphs on blank lines and turns a single newline into a break", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({
      t: "p",
      c: [{ t: "text", v: "one" }, { t: "br" }, { t: "text", v: "two" }],
    });
  });

  it("parses headings and horizontal rules", () => {
    expect(parseMarkdown("## Title ##")[0]).toEqual({
      t: "h",
      level: 2,
      c: [{ t: "text", v: "Title" }],
    });
    expect(parseMarkdown("---")[0]).toEqual({ t: "hr" });
  });

  it("parses backtick and tilde fenced code, keeping the body verbatim", () => {
    expect(parseMarkdown("```ts\nconst a = *b*;\n```")[0]).toEqual({
      t: "code",
      lang: "ts",
      v: "const a = *b*;",
    });
    expect(parseMarkdown("~~~\nx\n~~~")[0]).toMatchObject({
      t: "code",
      v: "x",
    });
  });

  it("treats an unclosed fence as code to the end (a streaming reply)", () => {
    expect(parseMarkdown("```py\nprint(1)\nfor")[0]).toMatchObject({
      t: "code",
      v: "print(1)\nfor",
    });
  });

  it("ends a paragraph at a list, fence, or heading", () => {
    const blocks = parseMarkdown("Steps:\n- a\n- b");
    expect(blocks.map((b) => b.t)).toEqual(["p", "list"]);
  });

  it("parses bullet and ordered lists, with the ordered start number", () => {
    const list = parseMarkdown("3. three\n4. four")[0];
    expect(list).toMatchObject({ t: "list", ordered: true, start: 3 });
    if (list.t !== "list") throw new Error("not a list");
    expect(list.items).toHaveLength(2);
    expect(parseMarkdown("- a\n- b")[0]).toMatchObject({
      t: "list",
      ordered: false,
    });
  });

  it("nests lists by indentation", () => {
    const list = parseMarkdown("- one\n  - nested a\n  - nested b\n- two")[0];
    if (list.t !== "list") throw new Error("not a list");
    expect(list.items).toHaveLength(2);
    const nested = list.items[0].find((b) => b.t === "list");
    expect(nested).toMatchObject({ t: "list" });
    if (nested?.t !== "list") throw new Error("no nested list");
    expect(nested.items).toHaveLength(2);
  });

  it("continues a list item lazily and across an indented blank line", () => {
    const lazy = parseMarkdown("- one\ncontinued\n- two")[0];
    if (lazy.t !== "list") throw new Error("not a list");
    expect(lazy.items).toHaveLength(2);
    const spaced = parseMarkdown("- one\n\n  more of one\n- two")[0];
    if (spaced.t !== "list") throw new Error("not a list");
    expect(spaced.items).toHaveLength(2);
    expect(spaced.items[0]).toHaveLength(2); // two paragraphs in item one
  });

  it("parses blockquotes, including inline formatting inside", () => {
    const q = parseMarkdown("> quoted *text*\n> more")[0];
    if (q.t !== "quote") throw new Error("not a quote");
    expect(q.c[0].t).toBe("p");
  });

  it("leaves tables as plain paragraph text", () => {
    expect(parseMarkdown("| a | b |\n|---|---|")[0].t).toBe("p");
  });
});

describe("markdown inline", () => {
  it("parses bold, italic, and inline code", () => {
    expect(para("**b** *i* `c`")).toEqual([
      { t: "strong", c: [{ t: "text", v: "b" }] },
      { t: "text", v: " " },
      { t: "em", c: [{ t: "text", v: "i" }] },
      { t: "text", v: " " },
      { t: "code", v: "c" },
    ]);
  });

  it("does not treat intraword underscores or spaced asterisks as emphasis", () => {
    expect(para("use snake_case_name here")).toEqual([
      { t: "text", v: "use snake_case_name here" },
    ]);
    expect(para("2 * 3 * 4")).toEqual([{ t: "text", v: "2 * 3 * 4" }]);
  });

  it("leaves unclosed emphasis, code and brackets literal (streaming)", () => {
    expect(para("half **bold and `code")).toEqual([
      { t: "text", v: "half **bold and `code" },
    ]);
    expect(para("[label](http://x")).toEqual([
      { t: "text", v: "[label](http://x" },
    ]);
  });

  it("does not format inside code spans", () => {
    expect(para("`*not em*`")).toEqual([{ t: "code", v: "*not em*" }]);
  });

  it("honours backslash escapes", () => {
    const md = `${BS}*not italic${BS}* and ${BS}\`not code${BS}\``;
    expect(para(md)).toEqual([{ t: "text", v: "*not italic* and `not code`" }]);
  });

  it("parses links, including balanced parentheses and a title", () => {
    expect(para("[a](https://x.dev/p_(q))")[0]).toMatchObject({
      t: "link",
      href: "https://x.dev/p_(q)",
    });
    expect(para('[a](https://x.dev "the title")')[0]).toMatchObject({
      t: "link",
      href: "https://x.dev",
    });
  });

  it("never turns raw HTML into anything but text", () => {
    const inline = para(
      "<script>alert(1)</script> <img src=x onerror=alert(2)>"
    );
    expect(inline.every((n) => n.t === "text")).toBe(true);
  });
});

describe("markdown safeHref", () => {
  it("allows absolute http and https URLs", () => {
    expect(safeHref("https://ok.dev/a?b=1")).toBe("https://ok.dev/a?b=1");
    expect(safeHref("http://ok.dev")).toBe("http://ok.dev/");
  });

  it("rejects javascript:, data:, mixed-case, relative and protocol-relative URLs", () => {
    for (const bad of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "/local/path",
      "//evil.com/x",
      "not a url",
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
  });
});

describe("markdown depth caps", () => {
  it("does not overflow the stack on nested list dashes", () => {
    const blocks = parseMarkdown(`${"- ".repeat(2500)}x`);
    expect(depthOf(blocks)).toBeLessThanOrEqual(MAX_BLOCK_DEPTH);
  });

  it("does not overflow the stack on thousands of quote markers", () => {
    const blocks = parseMarkdown(`${">".repeat(20000)} x`);
    expect(depthOf(blocks)).toBeLessThanOrEqual(MAX_BLOCK_DEPTH);
  });

  it("does not overflow the stack on unmatched emphasis or brackets", () => {
    expect(() =>
      parseMarkdown(`${"*a ".repeat(5000)}${"*".repeat(5000)}`)
    ).not.toThrow();
    expect(() =>
      parseMarkdown(`${"[".repeat(5000)}${"](http://x)".repeat(5000)}`)
    ).not.toThrow();
  });

  it("keeps all of the text when the cap is hit", () => {
    const text = JSON.stringify(parseMarkdown(`${"- ".repeat(2500)}tail`));
    expect(text).toContain("tail");
  });
});
