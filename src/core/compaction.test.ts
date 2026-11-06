import { expect, test } from "bun:test";
import { clearProfile, enabledTools, needsCompaction, setToolEnabled, useProfile, type Conversation } from "./compaction.ts";
import { decodeSession, encodeSession, parseSessionCommand } from "./sessions.ts";

test("compacts once the last prompt reaches 80% of the context window", () => {
  expect(needsCompaction(79, 100)).toBe(false);
  expect(needsCompaction(80, 100)).toBe(true);
});

test("switching a tool off removes it from the offered tools, and on restores it", () => {
  const start: Conversation = { history: [], compacted: false };
  const off = setToolEnabled(start, "edit_file", false);
  expect(off.notice).toBe("tool edit_file off");
  expect(enabledTools(off.conversation)).not.toContain("edit_file");
  const on = setToolEnabled(off.conversation, "edit_file", true);
  expect(enabledTools(on.conversation)).toContain("edit_file");
  expect(on.conversation.disabledTools).toEqual([]);
});

test("using a profile makes it pending and clearing turns it off, keeping the history", () => {
  const start: Conversation = { history: [{ role: "user", content: "hi" }], compacted: false };
  const on = useProfile(start, { name: "terse", text: "Be brief." });
  expect(on.notice).toBe("profile: terse");
  expect(on.conversation.profile).toEqual({ name: "terse", text: "Be brief." });
  expect(on.conversation.pendingProfile).toBe("Be brief.");
  expect(on.conversation.history).toEqual(start.history);
  const off = clearProfile(on.conversation);
  expect(off.notice).toBe("profile: default");
  expect(off.conversation.profile).toBeUndefined();
  expect(off.conversation.pendingProfile).toBeUndefined();
  expect(off.conversation.history).toEqual(start.history);
});

test("a session file reads back to the conversation it was saved from, and a bad one is refused", () => {
  const conversation: Conversation = {
    history: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_files", arguments: "{}" }] },
      { role: "tool", toolCallId: "c1", content: "a.txt" },
    ],
    promptTokens: 42,
    compacted: false,
    profile: { name: "terse", text: "Be brief." },
    disabledTools: ["kill_command"],
  };
  expect(decodeSession(encodeSession(conversation))).toEqual({ ok: true, value: conversation });
  expect(decodeSession("not json").ok).toBe(false);
  expect(decodeSession('{"version":1,"history":[],"compacted":false,"disabledTools":["nope"]}').ok).toBe(false);
  expect(decodeSession('{"version":1,"history":[{"role":"robot"}],"compacted":false}').ok).toBe(false);
});

test("reads /save, /load, and /sessions, and refuses a bad name or use", () => {
  expect(parseSessionCommand(["save", "work"])).toEqual({ ok: true, value: { kind: "save", name: "work" } });
  expect(parseSessionCommand(["load", "work"])).toEqual({ ok: true, value: { kind: "load", name: "work" } });
  expect(parseSessionCommand(["sessions"])).toEqual({ ok: true, value: { kind: "list" } });
  expect(parseSessionCommand(["save", "a/b"]).ok).toBe(false);
  expect(parseSessionCommand(["save"]).ok).toBe(false);
});

test("refuses a session whose tool calls and results do not pair", () => {
  const call = { id: "c1", name: "list_files", arguments: "{}" };
  const orphanResult = '{"version":1,"history":[{"role":"tool","toolCallId":"c1","content":"x"}],"compacted":false}';
  const unanswered =
    '{"version":1,"history":[{"role":"user","content":"hi"},{"role":"assistant","content":"","toolCalls":[' +
    JSON.stringify(call) +
    "]}],\"compacted\":false}";
  expect(decodeSession(orphanResult).ok).toBe(false);
  expect(decodeSession(unanswered).ok).toBe(false);
});

test("a profile's whitelist and the /tools switches both limit the tools offered", () => {
  const conversation: Conversation = {
    history: [],
    compacted: false,
    disabledTools: ["kill_command"],
    profile: { name: "reader", text: "Read only.", tools: ["list_files", "read_file", "kill_command"] },
  };
  expect(enabledTools(conversation)).toEqual(["list_files", "read_file"]);
  expect(enabledTools({ ...conversation, profile: undefined })).toContain("edit_file");
});

test("queued hook output is kept by a saved session", () => {
  const conversation: Conversation = { history: [], compacted: false, pendingOutput: "[hook]\ntext" };
  expect(decodeSession(encodeSession(conversation))).toEqual({ ok: true, value: conversation });
});

test("a saved session keeps the hooks its profile adds", () => {
  const conversation: Conversation = {
    history: [],
    compacted: false,
    profile: { name: "tester", text: "Body.", hooks: [{ point: "turnEnd", command: "npm test" }] },
  };
  expect(decodeSession(encodeSession(conversation))).toEqual({ ok: true, value: conversation });
});
