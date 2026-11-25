import { describe, expect, test } from "bun:test";
import { parseChatStreamEvent } from "./index";

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
