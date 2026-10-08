import { expect, test } from "bun:test";
import { createLineModel } from "../web/src/transcript/chat-lines.ts";

const element = (): HTMLElement => ({}) as HTMLElement;

test("lines are recorded in order with ids that count up and are never reused", () => {
  const model = createLineModel();
  const a = model.add("user", "hello", element());
  const b = model.add("assistant", "", element());
  expect([a.id, b.id]).toEqual([1, 2]);
  expect(model.lines.map((l) => l.cls)).toEqual(["user", "assistant"]);
  model.clear();
  expect(model.lines).toHaveLength(0);
  expect(model.add("user", "again", element()).id).toBe(3);
});

test("a streamed line records what it finally says", () => {
  const model = createLineModel();
  const el = element();
  model.add("assistant", "", el);
  model.settle(el, "the whole reply");
  expect(model.lines[0]?.text).toBe("the whole reply");
  model.settle(element(), "ignored: not a recorded line");
  expect(model.lines).toHaveLength(1);
});

test("a transient line (a progress bar) can be taken out of the record", () => {
  const model = createLineModel();
  const bar = element();
  model.add("user", "hello", element());
  model.add("progress", "", bar);
  model.add("assistant", "hi", element());
  model.remove(bar);
  expect(model.lines.map((l) => l.cls)).toEqual(["user", "assistant"]);
  model.remove(element());
  expect(model.lines).toHaveLength(2);
});
