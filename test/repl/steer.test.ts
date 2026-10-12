import { expect, test } from "bun:test";
import type { Message } from "@vise/core";
import { NoticeQueue } from "../../packages/backend/src/repl/turn/round-hooks.ts";

const steer = (content: string): Message => ({
  role: "user",
  content,
  typed: true,
});

test("steering words join the conversation at the next round, after earlier notices", () => {
  const queue = new NoticeQueue();
  queue.add("[a tab was shared]");
  queue.steer(steer("use the other file"));
  const messages: Message[] = [];
  queue.drainInto(messages);
  expect(messages.map((m) => m.content)).toEqual([
    "[a tab was shared]",
    "use the other file",
  ]);
  expect(queue.takeSteers()).toEqual([]);
});

test("steering the turn ended without reading is handed back, notices stay queued", () => {
  const queue = new NoticeQueue();
  queue.add("[a tab was shared]");
  queue.steer(steer("too late"));
  expect(queue.takeSteers().map((m) => m.content)).toEqual(["too late"]);
  const messages: Message[] = [];
  queue.drainInto(messages);
  expect(messages.map((m) => m.content)).toEqual(["[a tab was shared]"]);
});
