import { describe, expect, test } from "bun:test";
import {
  generationReporter,
  toolBeingCalled,
} from "../src/client/generation.ts";
import { streamChat } from "../src/client/stream-reader.ts";
import type { GenerationProgress } from "../src/core/errors.ts";
import {
  describeWriting,
  QUIET_MS,
  shouldShowWriting,
} from "../web/src/generating.ts";
import { splitVerdict } from "../web/src/goal-ui.ts";
import { createThinking, thinkingMeta } from "../web/src/thinking.ts";

function sse(chunks: object[]): ReadableStream<Uint8Array> {
  const text =
    chunks.map((c) => `data: ${JSON.stringify(c)}\n`).join("") +
    "data: [DONE]\n";
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe("generation progress", () => {
  test("streamChat hands the server's token count and the raw text to the listener", async () => {
    const seen: string[] = [];
    await streamChat(
      sse([
        {
          choices: [{ delta: { content: "ab" } }],
          timings: { predicted_n: 1 },
        },
        {
          choices: [{ delta: { content: "cd" } }],
          timings: { predicted_n: 2 },
        },
      ]),
      undefined,
      undefined,
      undefined,
      undefined,
      { text: (p) => seen.push(`t:${p}`), tokens: (n) => seen.push(`n:${n}`) },
    );
    expect(seen).toEqual(["t:ab", "n:1", "t:cd", "n:2"]);
  });

  test("the tool being called is named once its call has started", () => {
    expect(
      toolBeingCalled('hello <tool_call>{"name":"create_file","argu'),
    ).toBe("create_file");
    expect(
      toolBeingCalled('<tool_call>{"name":"a"}</tool_call> text'),
    ).toBeUndefined();
    expect(toolBeingCalled("plain reply")).toBeUndefined();
  });

  test("reports every 20 tokens or 250 ms, and a final done", () => {
    const got: GenerationProgress[] = [];
    let time = 1000;
    const g = generationReporter(
      (p) => got.push(p),
      7,
      "reply",
      () => time,
    );
    g.text('<tool_call>{"name":"create_file"');
    g.tokens(5); // first report (nothing reported yet, 250 ms rule)
    g.tokens(10); // too soon, too few
    time += 300;
    g.tokens(11); // 250 ms passed
    g.done();
    expect(got.map((p) => [p.tokens, p.done, p.tool])).toEqual([
      [5, false, "create_file"],
      [11, false, "create_file"],
      [11, true, undefined],
    ]);
    expect(got[0]?.request).toBe(7);
  });
});

describe("page pieces", () => {
  test("the writing line shows only for a quiet, unfinished call", () => {
    expect(shouldShowWriting(false, QUIET_MS)).toBe(true);
    expect(shouldShowWriting(false, QUIET_MS - 1)).toBe(false);
    expect(shouldShowWriting(true, QUIET_MS * 10)).toBe(false);
    expect(describeWriting(1240, "Create file")).toBe(
      "Writing Create file · 1,240 tokens",
    );
    expect(describeWriting(3, undefined)).toBe("Writing · 3 tokens");
  });

  test("a verdict splits into title and evidence", () => {
    expect(splitVerdict("✓ goal met — tests pass")).toEqual({
      title: "✓ goal met",
      detail: "tests pass",
    });
    expect(splitVerdict("✓ goal met")).toEqual({
      title: "✓ goal met",
      detail: "",
    });
  });

  test("thinking counts tokens in its header and renders markdown when it ends", () => {
    const line = {
      className: "line thinking",
      textContent: "",
      innerHTML: "",
      attrs: {} as Record<string, string>,
    };
    const el = Object.assign(line, {
      setAttribute(k: string, v: string) {
        line.attrs[k] = v;
      },
    });
    let settled = "";
    const t = createThinking({
      addLine: () => el as unknown as HTMLElement,
      settle: (_l, text) => (settled = text),
      follow: () => {},
      renderHtml: (md) => `<p>${md}</p>`,
    });
    t.append("a");
    t.append("b");
    expect(line.attrs["data-meta"]).toBe(thinkingMeta(2));
    expect(thinkingMeta(1)).toBe(" · 1 token");
    t.end();
    expect(line.innerHTML).toBe("<p>ab</p>");
    expect(line.className).toContain("rendered");
    expect(settled).toBe("ab");
    expect(t.active()).toBe(false);
  });
});

test("a tool call is reported as soon as its name is known, even when it is short", () => {
  const got: GenerationProgress[] = [];
  let time = 1000;
  const g = generationReporter((p) => got.push(p), 1, "reply", () => time);
  g.tokens(1); // first report, no tool yet
  g.text('<tool_call>{"name":"read_file"');
  g.tokens(2); // too few tokens and too soon, but the tool is now known
  g.tokens(3); // same tool: nothing new
  expect(got.map((p) => [p.tokens, p.tool])).toEqual([[1, undefined], [2, "read_file"]]);
});
