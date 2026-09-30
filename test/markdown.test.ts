import { describe, test, expect } from "bun:test";
import { renderLine } from "../src/output/markdown.ts";

describe("renderLine (markdown)", () => {
  test("returns plain text unchanged", () => {
    const [styled, inFence] = renderLine("hello world", false);
    expect(styled).toBe("hello world");
    expect(inFence).toBe(false);
  });

  test("bolds a heading", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled] = renderLine("# Title", false);
      expect(styled).toBe("Title");
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("dims a blockquote", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled] = renderLine("> quoted text", false);
      expect(styled).toBe("quoted text");
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("indents a list item", () => {
    const [styled] = renderLine("- a bullet", false);
    expect(styled).toBe("  a bullet");
  });

  test("indents a numbered list item", () => {
    const [styled] = renderLine("1. first", false);
    expect(styled).toBe("  first");
  });

  test("dims code fence markers and toggles state", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled1, inFence1] = renderLine("```", false);
      expect(styled1).toBe("```");
      expect(inFence1).toBe(true);
      const [styled2, inFence2] = renderLine("```ts", true);
      expect(styled2).toBe("```ts");
      expect(inFence2).toBe(true);
      const [styled3, inFence3] = renderLine("```", true);
      expect(styled3).toBe("```");
      expect(inFence3).toBe(false);
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("dims content inside a code fence", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled, inFence] = renderLine("const x = 1;", true);
      expect(styled).toBe("const x = 1;");
      expect(inFence).toBe(true);
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("styles inline code spans (no ANSI when NO_COLOR)", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled] = renderLine("use `code` here", false);
      expect(styled).toBe("use code here");
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("styles bold inline spans (no ANSI when NO_COLOR)", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled] = renderLine("this is **bold** text", false);
      expect(styled).toBe("this is bold text");
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("styles links (no ANSI when NO_COLOR)", () => {
    process.env.NO_COLOR = "1";
    try {
      const [styled] = renderLine("see [Vise](https://example.com) docs", false);
      expect(styled).toBe("see Vise(https://example.com) docs");
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("emits ANSI codes for headings when color is enabled", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const [styled] = renderLine("# Title", false);
      expect(styled).toBe("\x1b[1mTitle\x1b[0m");
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
    }
  });

  test("emits dim codes for blockquotes when color is enabled", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const [styled] = renderLine("> quoted", false);
      expect(styled).toBe("\x1b[2mquoted\x1b[0m");
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
    }
  });

  test("emits cyan codes for inline code when color is enabled", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const [styled] = renderLine("use `code` here", false);
      expect(styled).toBe("use \x1b[36mcode\x1b[0m here");
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
    }
  });

  test("emits bold codes for inline bold when color is enabled", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const [styled] = renderLine("this is **bold** text", false);
      expect(styled).toBe("this is \x1b[1mbold\x1b[0m text");
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
    }
  });

  test("emits cyan label + dim url for links when color is enabled", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      const [styled] = renderLine("see [Vise](https://example.com) docs", false);
      expect(styled).toBe(
        "see \x1b[36mVise\x1b[0m\x1b[2m(https://example.com)\x1b[0m docs",
      );
    } finally {
      if (saved === undefined) delete process.env.FORCE_COLOR;
      else process.env.FORCE_COLOR = saved;
    }
  });

  test("preserves fence state across content lines", () => {
    process.env.NO_COLOR = "1";
    try {
      const [, f1] = renderLine("```", false);
      expect(f1).toBe(true);
      const [, f2] = renderLine("line one", true);
      expect(f2).toBe(true);
      const [, f3] = renderLine("line two", true);
      expect(f3).toBe(true);
      const [, f4] = renderLine("```", true);
      expect(f4).toBe(false);
    } finally {
      delete process.env.NO_COLOR;
    }
  });

  test("handles tilde fences", () => {
    process.env.NO_COLOR = "1";
    try {
      const [, f1] = renderLine("~~~", false);
      expect(f1).toBe(true);
      const [, f2] = renderLine("~~~", true);
      expect(f2).toBe(false);
    } finally {
      delete process.env.NO_COLOR;
    }
  });
});
