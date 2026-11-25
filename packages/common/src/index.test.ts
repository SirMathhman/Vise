import { describe, expect, test } from "bun:test";
import {
  MAX_CONVERSATION_MESSAGES,
  fitsBudget,
  parseChatMessageList,
  parseChatStreamEvent,
  trimToBudget,
} from "./index";

describe("conversation budget", () => {
  test("fitsBudget rejects too many messages", () => {
    const many = Array.from({ length: MAX_CONVERSATION_MESSAGES + 1 }, () => ({
      role: "user" as const,
      content: "x",
    }));
    expect(fitsBudget(many)).toBe(false);
    expect(fitsBudget(many.slice(1))).toBe(true);
  });

  test("trimToBudget drops the oldest messages and keeps the newest", () => {
    const messages = [
      { role: "user" as const, content: "a".repeat(15000) },
      { role: "assistant" as const, content: "b".repeat(15000) },
      { role: "user" as const, content: "c" },
    ];
    expect(trimToBudget(messages)).toEqual(messages.slice(1));
  });

  test("trimToBudget keeps a leading system message", () => {
    const messages = [
      { role: "system" as const, content: "dir" },
      { role: "user" as const, content: "a".repeat(15000) },
      { role: "assistant" as const, content: "b".repeat(15000) },
      { role: "user" as const, content: "c" },
    ];
    expect(trimToBudget(messages)).toEqual([
      messages[0],
      messages[2],
      messages[3],
    ]);
  });
});

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
