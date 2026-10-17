import { describe, expect, test } from "bun:test";
import type { Client, Message } from "@vise/core";
import {
  SUMMARY_FRAME_PREFIX,
  growthProblem,
  splitForCompaction,
  summarizesNothing,
  summaryProblem,
} from "@vise/core";
import { runCompaction } from "../../../packages/backend/src/repl/turn/compaction.ts";

const user = (content: string): Message => ({ role: "user", content, typed: true });
const frame = (text = "earlier work"): Message => ({
  role: "user",
  content: `${SUMMARY_FRAME_PREFIX} ${text}`,
});
const assistant = (content: string): Message => ({ role: "assistant", content });
const tool = (content: string): Message => ({ role: "tool", content, tool_call_id: "t" });

describe("splitForCompaction", () => {
  test("a summary frame is not a turn", () => {
    const messages = [frame(), user("one"), assistant("a"), user("two"), assistant("b")];
    const { toSummarize, recent } = splitForCompaction(messages, 2);
    expect(toSummarize).toEqual([messages[0]!]);
    expect(recent).toHaveLength(4);
    const three = [frame(), user("one"), assistant("a"), user("two"), user("three")];
    expect(splitForCompaction(three, 2).toSummarize).toHaveLength(3);
  });

  test("only a frame and one turn: nothing worth summarizing", () => {
    const { toSummarize } = splitForCompaction([frame(), user("one"), assistant("a")], 2);
    expect(summarizesNothing(toSummarize)).toBe(true);
  });
});

describe("summarizesNothing", () => {
  test("true for none or only frames, false once a real message is included", () => {
    expect(summarizesNothing([])).toBe(true);
    expect(summarizesNothing([frame(), frame()])).toBe(true);
    expect(summarizesNothing([frame(), assistant("x")])).toBe(false);
  });
});

describe("summaryProblem", () => {
  const big = [tool("x".repeat(20_000))];
  test("rejects empty, tiny and tool-call summaries; accepts a real one", () => {
    expect(summaryProblem("  ", big)).toContain("empty");
    expect(summaryProblem("I'll verify the current file state first.", big)).toContain("too short");
    expect(summaryProblem(`${"s".repeat(400)}<|tool_call|>`, big)).toContain("tool call");
    expect(summaryProblem("s".repeat(400), big)).toBeUndefined();
  });
  test("a short conversation may have a short summary", () => {
    expect(summaryProblem("ok then", [user("hi")])).toBeUndefined();
  });
});

describe("growthProblem", () => {
  test("flags a result that is not smaller", () => {
    const before = [user("a".repeat(100)), assistant("b".repeat(100))];
    expect(growthProblem(before, [user("c".repeat(500))])).toContain("not shrink");
    expect(growthProblem(before, [user("c")])).toBeUndefined();
  });
});

describe("runCompaction", () => {
  function setup(reply: string, body: Message[]) {
    let current: Message[] = [{ role: "system", content: "sys" }, ...body];
    let calls = 0;
    const client: Client = {
      chat: async () => {
        calls++;
        return { ok: true, value: { content: reply } };
      },
    };
    return {
      source: {
        client,
        messages: () => [...current],
        resetMessages: (b: Message[]) => (current = [current[0]!, ...b]),
      },
      body: () => current.slice(1),
      calls: () => calls,
    };
  }
  const bulky = [
    frame("old"),
    user("do the thing"),
    ...Array.from({ length: 14 }, (_, i) => [
      assistant(`step ${i}`),
      tool("r".repeat(4000)),
    ]).flat(),
  ];

  test("a frame plus one big turn is compacted inside the turn, not just the old frame", async () => {
    const t = setup("S".repeat(500), bulky);
    const result = await runCompaction(t.source);
    expect(result.ok).toBe(true);
    expect(t.body().length).toBeLessThan(bulky.length);
    expect(t.body()[0]?.content.startsWith(SUMMARY_FRAME_PREFIX)).toBe(true);
  });

  test("an empty or junk summary leaves the conversation untouched", async () => {
    for (const reply of ["", "I'll verify the current file state."]) {
      const t = setup(reply, bulky);
      const result = await runCompaction(t.source);
      expect(result.ok).toBe(false);
      expect(t.body()).toEqual(bulky);
    }
  });

  test("a result that does not shrink the conversation is refused", async () => {
    const small = [
      frame("old"),
      user("a"),
      ...Array.from({ length: 14 }, () => [assistant("b"), tool("c")]).flat(),
    ];
    const t = setup("S".repeat(5000), small);
    const result = await runCompaction(t.source, true);
    expect(result.ok).toBe(false);
    expect(t.body()).toEqual(small);
  });

  test("with nothing but a frame and a short turn the model is not even asked", async () => {
    const t = setup("S".repeat(500), [frame(), user("hi"), assistant("hello")]);
    const result = await runCompaction(t.source);
    expect(result).toEqual({ ok: true, value: "nothing to compact" });
    expect(t.calls()).toBe(0);
  });
});
