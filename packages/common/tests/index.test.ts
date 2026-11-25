import { describe, expect, test } from "bun:test";
import {
  conversationLimit,
  fitsBudget,
  parseChatMessageList,
  parseChatStreamEvent,
  trimToBudget,
} from "../src/index";

describe("conversation budget", () => {
  test("the limit leaves room for the reply", () => {
    expect(conversationLimit(128_000)).toBe(124_000);
    expect(conversationLimit(1_000)).toBe(0);
  });

  test("fitsBudget counts about four characters per token", () => {
    const messages = [{ role: "user" as const, content: "x".repeat(4000) }];
    expect(fitsBudget(messages, 1000)).toBe(true);
    expect(fitsBudget(messages, 999)).toBe(false);
  });

  test("trimToBudget drops the oldest messages and keeps the newest", () => {
    const messages = [
      { role: "user" as const, content: "a".repeat(2000) },
      { role: "assistant" as const, content: "b".repeat(2000) },
      { role: "user" as const, content: "c" },
    ];
    expect(trimToBudget(messages, 1000)).toEqual(messages.slice(1));
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
