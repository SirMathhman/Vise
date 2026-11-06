import { expect, test } from "bun:test";
import { clearProfile, needsCompaction, useProfile, type Conversation } from "./compaction.ts";

test("compacts once the last prompt reaches 80% of the context window", () => {
  expect(needsCompaction(79, 100)).toBe(false);
  expect(needsCompaction(80, 100)).toBe(true);
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
