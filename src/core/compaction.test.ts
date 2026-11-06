import { expect, test } from "bun:test";
import { clearProfile, enabledTools, needsCompaction, setToolEnabled, useProfile, type Conversation } from "./compaction.ts";

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
