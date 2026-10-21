import { describe, expect, test } from "bun:test";
import type { Message } from "@vise/core";
import { applySettings } from "../../../packages/backend/src/config.ts";
import {
  makeRoundHook,
  NoticeQueue,
  roundsSinceWrite,
} from "../../../packages/backend/src/repl/turn/round-hooks.ts";

const call = (name: string): Message => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id: name, type: "function", function: { name, arguments: "{}" } }],
});
const writes = (name: string): boolean => name === "edit_file";

describe("roundsSinceWrite", () => {
  test("counts the rounds after the last file change", () => {
    const messages = [call("read_file"), call("edit_file"), call("read_file"), call("read_file")];
    expect(roundsSinceWrite(messages, writes)).toBe(2);
  });

  test("counts every round when nothing was ever changed", () => {
    expect(roundsSinceWrite([call("read_file"), call("read_file")], writes)).toBe(2);
  });
});

describe("the round hook", () => {
  const deps = (asked: number[]) => ({
    compact: async () => ({ ok: true as const, value: "ok" }),
    save: async () => {},
    progress: async (quiet?: number) => {
      asked.push(quiet ?? 0);
      return undefined;
    },
    writes,
  });

  test("checks progress, and nudges, once enough rounds pass without an edit", async () => {
    applySettings({ VISE_NO_WRITE_ROUNDS: "3" });
    const asked: number[] = [];
    const notices = new NoticeQueue();
    const hook = makeRoundHook(deps(asked), undefined, notices);
    const messages: Message[] = [];
    for (let round = 1; round <= 4; round++) {
      messages.push(call("read_file"));
      await hook(round, messages);
    }
    expect(asked).toEqual([3]);
    expect(messages.some((m) => m.content.includes("without changing any file"))).toBe(true);
    applySettings({});
  });

  test("an edit resets the count", async () => {
    applySettings({ VISE_NO_WRITE_ROUNDS: "3" });
    const asked: number[] = [];
    const hook = makeRoundHook(deps(asked), undefined, new NoticeQueue());
    const messages: Message[] = [];
    for (const name of ["read_file", "read_file", "edit_file", "read_file", "read_file"]) {
      messages.push(call(name));
      await hook(messages.length, messages);
    }
    expect(asked).toEqual([]);
    applySettings({});
  });
});
