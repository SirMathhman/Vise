import { describe, expect, test } from "bun:test";
import type { Message } from "@vise/core";
import {
  PIN_HEADING,
  PIN_LINE_MAX,
  PIN_TOTAL_MAX,
  SUMMARY_FRAME_PREFIX,
  parsePins,
  pinUserWords,
  renderPins,
} from "@vise/core";

const typed = (content: string): Message => ({ role: "user", content, typed: true });

describe("pinUserWords", () => {
  test("pins typed lines and ask_user answers, not notes or other tool results", () => {
    const messages: Message[] = [
      typed("Apply to a few jobs"),
      { role: "user", content: "[goal continue] do it now" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { type: "function", id: "a", function: { name: "ask_user", arguments: "{}" } },
          { type: "function", id: "b", function: { name: "read_file", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "a", content: "user replied: Type a simple answer, but don't submit, so I can look it over." },
      { role: "tool", tool_call_id: "b", content: "file text" },
    ];
    expect(pinUserWords(messages)).toEqual([
      "Apply to a few jobs",
      "(answer to a question) Type a simple answer, but don't submit, so I can look it over.",
    ]);
  });

  test("sessions saved before the typed mark pin every user line except bracketed notices", () => {
    const messages: Message[] = [
      { role: "user", content: "hello there" },
      { role: "user", content: "[notice] tab shared" },
    ];
    expect(pinUserWords(messages)).toEqual(["hello there"]);
  });

  test("lines are flattened, de-duplicated and clipped", () => {
    const long = "x".repeat(PIN_LINE_MAX + 50);
    const lines = pinUserWords([typed("a\n  b"), typed("a b"), typed(long)]);
    expect(lines[0]).toBe("a b");
    expect(lines).toHaveLength(2);
    expect(lines[1]?.length).toBe(PIN_LINE_MAX + 1);
  });

  test("an earlier summary's pins pass through a second compaction unchanged", () => {
    const first = `${SUMMARY_FRAME_PREFIX} things happened\n\n${renderPins(["don't submit yet"])}`;
    const lines = pinUserWords([{ role: "user", content: first }, typed("and then wait")]);
    expect(lines).toEqual(["don't submit yet", "and then wait"]);
  });
});

describe("renderPins", () => {
  test("round-trips through parsePins", () => {
    const block = renderPins(["one", "two"]);
    expect(block.startsWith(PIN_HEADING)).toBe(true);
    expect(parsePins(`${SUMMARY_FRAME_PREFIX} s\n\n${block}`)).toEqual(["one", "two"]);
  });

  test("nothing to pin renders nothing", () => {
    expect(renderPins([])).toBe("");
  });

  test("over the total the newest lines are kept and the cut is said", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `${i}-${"y".repeat(300)}`);
    const block = renderPins(lines);
    expect(block).toContain("(earlier lines omitted)");
    expect(block).toContain("29-");
    expect(block).not.toContain("\n- 0-");
    expect(block.length).toBeLessThan(PIN_TOTAL_MAX + 400);
  });
});
