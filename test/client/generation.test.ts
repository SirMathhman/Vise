import { describe, expect, test } from "bun:test";
import {
  generationReporter,
  toolBeingCalled,
} from "../../packages/backend/src/client/stream/generation.ts";
import { streamChat } from "../../packages/backend/src/client/stream/stream-reader.ts";
import type { GenerationProgress } from "@vise/core";
import {
  describeWriting,
  QUIET_MS,
  shouldShowWriting,
} from "../../packages/frontend/src/status/generating.ts";
import { splitVerdict } from "../../packages/frontend/src/status/goal-ui.ts";
import { createThinking, thinkingMeta } from "../../packages/frontend/src/transcript/thinking.ts";

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
    g.tokens(5); // first report (nothing reported yet, 250 ms rule); the call began here
    g.tokens(10); // too soon, too few
    time += 300;
    g.tokens(11); // 250 ms passed
    g.done();
    expect(got.map((p) => [p.tokens, p.done, p.tool])).toEqual([
      [0, false, "create_file"],
      [6, false, "create_file"],
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
  const time = 1000;
  const g = generationReporter((p) => got.push(p), 1, "reply", () => time);
  g.tokens(1); // first report, no tool yet
  g.text('<tool_call>{"name":"read_file"');
  g.tokens(2); // too few tokens and too soon, but the tool is now known
  g.tokens(3); // same tool: nothing new
  expect(got.map((p) => [p.tokens, p.tool])).toEqual([[1, undefined], [0, "read_file"]]);
});

test("a subagent call names its profile first", async () => {
  const { formatToolCall } = await import("../../packages/backend/src/output/tool-line.ts");
  expect(formatToolCall("run_subagent", { profile: "explore", task: "find the follow code" })).toContain(
    "· explore · find the follow code",
  );
});

test("read_file numbers its lines", async () => {
  const { readFile } = await import("../../packages/backend/src/tools/files.ts");
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const path = join(mkdtempSync(join(tmpdir(), "vise-read-")), "a.txt");
  writeFileSync(path, "one\ntwo\nthree\n");
  expect(readFile({ path })).toBe("1 | one\n2 | two\n3 | three");
  expect(readFile({ path, offset: 2, limit: 1 })).toContain("2 | two");
});

test("each call in one reply counts its own tokens, not the ones before it", () => {
  const got: GenerationProgress[] = [];
  const g = generationReporter((p) => got.push(p), 1, "reply", () => 0);
  g.tokens(30); // thinking and text before any call
  g.text('<tool_call>{"name":"read_file"');
  g.tokens(40);
  g.text('}</tool_call><tool_call>{"name":"edit_file"');
  g.tokens(100);
  g.tokens(130);
  expect(got.filter((p) => p.tool).map((p) => [p.tool, p.tokens])).toEqual([
    ["read_file", 0],
    ["edit_file", 0],
    ["edit_file", 30],
  ]);
});

test("nothing is reported while the prompt is still being read (no tokens written yet)", async () => {
  const seen: number[] = [];
  await streamChat(
    sse([
      { choices: [{ delta: {} }], prompt_progress: { total: 10, cache: 0, processed: 5, time_ms: 1 }, timings: { predicted_n: 0 } },
      { choices: [{ delta: { content: "a" } }], timings: { predicted_n: 1 } },
    ]),
    undefined,
    undefined,
    undefined,
    undefined,
    { text: () => {}, tokens: (n) => seen.push(n) },
  );
  expect(seen).toEqual([1]);
});

test("a profile switch tells the model what it gained and lost", async () => {
  const { ProfileToolGate } = await import("../../packages/backend/src/repl/profile-tools.ts");
  const states = new Map([["read_file", true], ["browser_open", false], ["create_file", true]]);
  const controller = {
    list: () => [...states].map(([name, enabled]) => ({ name, enabled })),
    set: (n: string, e: boolean) => void states.set(n, e),
    isEnabled: (n: string) => states.get(n) === true,
  };
  const sent: string[] = [];
  const gate = new ProfileToolGate(controller, (m) => sent.push(String(m.content)));
  gate.apply(["read_file", "browser_open"]);
  expect(sent[0]).toContain("Newly available: browser_open");
  expect(sent[0]).toContain("No longer available: create_file");
  gate.apply(undefined);
  expect(sent[1]).toContain("Newly available: create_file");
  expect(sent[1]).toContain("No longer available: browser_open");
});
