import { expect, test } from "bun:test";
import { collectLists } from "../../../packages/backend/src/repl/lists.ts";

test("every list comes from its own source, default profile first", async () => {
  const lists = await collectLists({
    profileSource: {
      listProfiles: async () => ({ ok: true as const, value: ["strict", "default"] }),
    } as never,
    activeProfile: "strict",
    toolController: {
      list: () => [{ name: "read_file", enabled: true, category: "files" }],
    } as never,
    reasoning: { getReasoningEffort: () => undefined, setReasoningEffort: () => undefined },
    sessionSource: {
      list: async () => ({
        ok: true as const,
        value: [{ id: "a", name: "first", updated: "2026-10-01T00:00:00.000Z" }, { id: "b", name: "second" }],
      }),
    } as never,
    burst: true,
  });
  expect(lists.profiles).toEqual({ names: ["default", "strict"], active: "strict" });
  expect(lists.tools).toEqual([{ name: "read_file", enabled: true, category: "files" }]);
  expect(lists.reasoning?.active).toBe("default");
  expect(lists.reasoning?.levels).toContain("high");
  expect(lists.sessions).toEqual([
    { id: "a", name: "first", updated: "2026-10-01T00:00:00.000Z" },
    { id: "b", name: "second" },
  ]);
  expect(lists.burst).toBe(true);
  expect(lists.errors).toEqual([]);
});

test("a list that cannot be read is left out and named, the others stay", async () => {
  const lists = await collectLists({
    sessionSource: {
      list: async () => ({ ok: false as const, error: { kind: "network" as const, cause: "x" } }),
    } as never,
    toolController: { list: () => [] } as never,
    activeProfile: undefined,
    burst: false,
  });
  expect(lists.sessions).toBeUndefined();
  expect(lists.tools).toEqual([]);
  expect(lists.errors).toEqual(["saved sessions could not be listed"]);
});
