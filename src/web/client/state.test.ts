import { expect, test } from "bun:test";
import type { ServerEvent } from "../../protocol/protocol.ts";
import {
  canSend,
  initialState,
  reduce,
  type ViewState,
} from "./state.ts";

// Applies server events in order, starting from the initial state.
function after(
  events: ServerEvent[],
  start: ViewState = { ...initialState, link: "live" },
): ViewState {
  return events.reduce(
    (state, event) => reduce(state, { kind: "server", event }),
    start,
  );
}

test("text joins the open reply, and a reply that has ended is followed by a new one", () => {
  const state = after([
    { kind: "text", text: "Hel" },
    { kind: "text", text: "lo" },
    { kind: "replyEnd" },
    { kind: "text", text: "Next" },
  ]);
  expect(state.blocks).toEqual([
    { kind: "reply", text: "Hello", done: true },
    { kind: "reply", text: "Next", done: false },
  ]);
});

test("an open approval locks the input until its answer arrives", () => {
  const open = after([
    { kind: "ready" },
    { kind: "approvalRequest", id: 4, preview: "edit f.txt" },
  ]);
  expect(canSend(open)).toBe(false);
  const answered = after(
    [{ kind: "approvalAnswered", id: 4, answer: "approve" }],
    open,
  );
  expect(canSend(answered)).toBe(true);
  expect(answered.blocks.at(-1)).toEqual({
    kind: "approval",
    id: 4,
    preview: "edit f.txt",
    answer: "approve",
  });
});

test("thinking is shown as an estimate until its final count arrives, and the session end is kept", () => {
  const state = after([
    { kind: "thinking", approximate: 10 },
    { kind: "thinking", approximate: 40 },
    { kind: "thinkingDone", tokens: 42, exact: true },
    { kind: "ended", error: "boom" },
  ]);
  expect(state.blocks).toEqual([
    { kind: "thinking", tokens: 42, exact: true, done: true },
  ]);
  expect(state.ended).toBe(true);
  expect(state.endError).toBe("boom");
  expect(canSend(state)).toBe(false);
});
