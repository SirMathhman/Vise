import { afterEach, expect, test } from "bun:test";
import { applySettings } from "../../src/config.ts";
import { historyEntries } from "../../src/web/conn/history.ts";
import type { Message } from "../../src/core/errors.ts";

afterEach(() => applySettings({}));

const conversation = (turns: number): Message[] => [
  { role: "system", content: "system" },
  { role: "user", content: "context" },
  ...Array.from({ length: turns }, (_, i): Message[] => [
    { role: "user", content: `question ${i}`, typed: true },
    { role: "assistant", content: `answer ${i}` },
  ]).flat(),
];

test("every restored line carries its position in the whole conversation", () => {
  const entries = historyEntries(conversation(3));
  expect(entries.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5]);
});

test("when earlier lines are left out the rest keep their positions and the note has seq -1", () => {
  applySettings({ VISE_HISTORY_MAX_ENTRIES: "4" });
  const entries = historyEntries(conversation(5));
  expect(entries[0]).toMatchObject({ kind: "note", seq: -1 });
  expect(entries.slice(1).map((e) => e.seq)).toEqual([6, 7, 8, 9]);
});
