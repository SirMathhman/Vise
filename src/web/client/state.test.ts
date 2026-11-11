import { expect, test } from "bun:test";
import type { ServerEvent } from "../../protocol/protocol.ts";
import {
  canSend,
  initialState,
  reduce,
  toolsAfterEdit,
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

test("the page remembers the newest approval question it showed", () => {
  const state = after([
    { kind: "approvalRequest", id: 2, preview: "a" },
    { kind: "approvalAnswered", id: 2, answer: "refuse" },
    { kind: "approvalRequest", id: 5, preview: "b" },
  ]);
  expect(state.lastShown).toBe(5);
});

test("a history event replaces the transcript with the messages of the earlier conversation", () => {
  const state = after([
    { kind: "notice", text: "old" },
    {
      kind: "history",
      messages: [
        { role: "user", text: "earlier" },
        { role: "assistant", text: "reply" },
      ],
    },
  ]);
  expect(state.blocks).toEqual([
    { kind: "user", text: "earlier" },
    { kind: "reply", text: "reply", done: true },
  ]);
});

test("a sessions event sets the saved sessions the page offers", () => {
  const state = after([{ kind: "sessions", names: ["work", "plan"] }]);
  expect(state.sessions).toEqual(["work", "plan"]);
});

test("a tools event sets the switches the page offers", () => {
  const state = after([
    { kind: "tools", tools: [{ name: "a", enabled: true }, { name: "b", enabled: false }] },
  ]);
  expect(state.tools).toEqual([
    { name: "a", enabled: true },
    { name: "b", enabled: false },
  ]);
});

test("profiles and a profile detail set what the page's profile editor shows", () => {
  const detail = { name: "p", summary: "s", hooks: [], text: "t" };
  const state = after([
    { kind: "profiles", profiles: [{ name: "p", summary: "s" }] },
    { kind: "profile", profile: detail },
  ]);
  expect(state.profiles).toEqual([{ name: "p", summary: "s" }]);
  expect(state.profile).toEqual(detail);
});

test("saving a tool list keeps names the editor does not show, and an unchanged list stays as it was", () => {
  // Unchanged: the profile's own list, unknown name included.
  expect(toolsAfterEdit(["a", "ghost"], ["a", "b"], ["a"])).toEqual(["a", "ghost"]);
  // Ticking another tool adds it; unticking a shown one removes it.
  expect(toolsAfterEdit(["a"], ["a", "b"], ["a", "b"])).toEqual(["a", "b"]);
  expect(toolsAfterEdit(["a", "b"], ["a", "b"], ["b"])).toEqual(["b"]);
  // No list, every tool ticked: still no list. No list, some unticked: the ticked ones.
  expect(toolsAfterEdit(undefined, ["a", "b"], ["a", "b"])).toBeUndefined();
  expect(toolsAfterEdit(undefined, ["a", "b"], ["a"])).toEqual(["a"]);
});

test("an mcp event sets the servers as they started and as the file configures them", () => {
  const state = after([
    {
      kind: "mcp",
      running: [{ name: "fake", started: true, tools: ["fake__echo"], problems: [] }],
      servers: [{ name: "fake", command: "node", args: [] }],
    },
  ]);
  expect(state.mcp).toEqual({
    running: [{ name: "fake", started: true, tools: ["fake__echo"], problems: [] }],
    servers: [{ name: "fake", command: "node", args: [] }],
  });
});

test("an ask question keeps the composer locked until it is answered", () => {
  const asked = after([{ kind: "ask", id: 4, question: "Which?", choices: ["a", "b"] }]);
  expect(canSend(asked)).toBe(false);
  expect(asked.blocks).toEqual([{ kind: "ask", id: 4, question: "Which?", choices: ["a", "b"] }]);
  const answered = reduce(asked, { kind: "server", event: { kind: "askAnswered", id: 4, answer: "the user chose: a" } });
  expect(canSend(answered)).toBe(true);
  expect(answered.blocks).toEqual([
    { kind: "ask", id: 4, question: "Which?", choices: ["a", "b"], answer: "the user chose: a" },
  ]);
});

test("a file event sets the file the viewer shows", () => {
  expect(after([{ kind: "file", path: "a.txt", text: "hi" }]).file).toEqual({ path: "a.txt", text: "hi" });
});

test("a folder event sets the folder the page shows", () => {
  expect(after([{ kind: "folder", path: "C:/work" }]).folder).toBe("C:/work");
});

test("a tree event sets the entries of its folder, and a folder event starts the tree again", () => {
  const entries = [{ name: "a.txt", path: "a.txt", directory: false }];
  const read = after([{ kind: "tree", path: "", entries }]);
  expect(read.trees).toEqual({ "": entries });
  const opened = reduce(read, { kind: "folderOpen", path: "sub", open: true });
  expect(opened.expanded).toEqual(["sub"]);
  expect(reduce(opened, { kind: "folderOpen", path: "sub", open: false }).expanded).toEqual([]);
  const moved = after([{ kind: "tree", path: "", entries }, { kind: "folder", path: "C:/other" }]);
  expect(moved.trees).toEqual({});
  expect(moved.expanded).toEqual([]);
});

test("open files: the session's list sets the tabs, a shown file's text is kept, and a dropped file is gone", () => {
  const opened = after([
    { kind: "openFiles", paths: ["a.txt", "b.txt"] },
    { kind: "file", path: "a.txt", text: "A" },
    { kind: "file", path: "b.txt", text: "B" },
  ]);
  expect(opened.openFiles).toEqual(["a.txt", "b.txt"]);
  expect(opened.file).toEqual({ path: "b.txt", text: "B" });
  const shown = reduce(opened, { kind: "showFile", path: "a.txt" });
  expect(shown.file).toEqual({ path: "a.txt", text: "A" });
  const dropped = reduce(shown, { kind: "dropFile", path: "a.txt" });
  expect(dropped.openFiles).toEqual(["b.txt"]);
  expect(dropped.files).toEqual([{ path: "b.txt", text: "B" }]);
  expect(dropped.file).toEqual({ path: "b.txt", text: "B" });
  expect(after([{ kind: "openFiles", paths: ["a.txt"] }, { kind: "folder", path: "C:/other" }]).openFiles).toEqual([]);
});

test("the earlier button raises how many of the last blocks are built", () => {
  const first = initialState;
  const more = reduce(first, { kind: "showEarlier" });
  expect(more.recent).toBe(first.recent + 200);
});
