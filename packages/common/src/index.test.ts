import { describe, expect, test } from "bun:test";
import { parseChatMessageList, parseChatStreamEvent } from "./index";

describe("parseChatMessageList", () => {
  test("accepts a list of user and assistant messages with text", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(parseChatMessageList(messages)).toEqual({
      ok: true,
      value: messages,
    });
  });

  test("rejects values that are not usable messages", () => {
    for (const value of [
      "text",
      [{ role: "system", content: "x" }],
      [{ role: "user", content: "  " }],
      [null],
    ]) {
      expect(parseChatMessageList(value).ok).toBe(false);
    }
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
