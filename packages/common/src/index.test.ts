import { describe, expect, test } from "bun:test";
import { pageText, parseChatStreamEvent } from "./index";

describe("pageText", () => {
  test("splits text into pages of at most the page size", () => {
    expect(pageText("abcdefg", 3)).toEqual(["abc", "def", "g"]);
  });

  test("returns one empty page for empty text", () => {
    expect(pageText("", 3)).toEqual([""]);
  });

  test("keeps text that fits in one page as a single page", () => {
    expect(pageText("abc", 3)).toEqual(["abc"]);
  });
});

describe("parseChatStreamEvent", () => {
  test("accepts delta, done, and error events", () => {
    expect(parseChatStreamEvent({ type: "delta", text: "hi" })).toEqual({
      ok: true,
      value: { type: "delta", text: "hi" },
    });
    expect(parseChatStreamEvent({ type: "done" })).toEqual({
      ok: true,
      value: { type: "done" },
    });
    expect(parseChatStreamEvent({ type: "error", message: "x" })).toEqual({
      ok: true,
      value: { type: "error", message: "x" },
    });
  });

  test("rejects values that break the event contract", () => {
    for (const value of [
      { type: "delta" },
      { type: "delta", text: 3 },
      { type: "error" },
      { type: "nope" },
      null,
      "text",
    ]) {
      expect(parseChatStreamEvent(value).ok).toBe(false);
    }
  });
});
