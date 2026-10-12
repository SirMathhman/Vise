import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HookStore, loadHookCommands } from "../../../src/edge-sources.ts";
import { handleHooksCommand } from "../../../src/repl/commands/hooks-commands.ts";

function project(config?: object): { root: string; store: HookStore } {
  const root = mkdtempSync(join(tmpdir(), "vise-hooks-"));
  if (config) writeFileSync(join(root, ".viserc.json"), JSON.stringify(config));
  return { root, store: new HookStore(root) };
}

const state = (store: HookStore) => ({
  pre: store.pre,
  post: store.post,
  preTool: store.preTool,
  postTool: store.postTool,
  source: store,
});

const saved = (root: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(root, ".viserc.json"), "utf8"));

test("tool hooks load from strings and {command, tools} objects", () => {
  const { root } = project({
    preToolCommand: ["a", { command: "b", tools: ["files"] }],
    postToolCommand: "c",
  });
  expect(loadHookCommands(root)).toEqual({
    preTool: [{ command: "a" }, { command: "b", tools: ["files"] }],
    postTool: [{ command: "c" }],
  });
});

test("/hooks add pretool saves the hook, with its tool filter, to .viserc.json", async () => {
  const { root, store } = project({ preTurnCommand: "keep" });
  const added = await handleHooksCommand(
    '/hooks add pretool "node guard.js" --tools edit_file,shell',
    state(store),
  );
  expect(added).toEqual({
    ok: true,
    value: "added pre-tool hook: node guard.js  [tools: edit_file, shell]",
  });
  expect(store.preTool).toEqual([{ command: "node guard.js", tools: ["edit_file", "shell"] }]);
  expect(saved(root)).toEqual({
    preTurnCommand: ["keep"],
    preToolCommand: [{ command: "node guard.js", tools: ["edit_file", "shell"] }],
  });
});

test("a tool hook without a filter is saved as a plain string and removed by number", async () => {
  const { root, store } = project();
  await handleHooksCommand("/hooks add posttool bun run lint", state(store));
  expect(saved(root).postToolCommand).toEqual(["bun run lint"]);
  const removed = await handleHooksCommand("/hooks remove posttool 1", state(store));
  expect(removed.ok).toBe(true);
  expect(store.postTool).toEqual([]);
  expect(saved(root).postToolCommand).toBeUndefined();
  const again = await handleHooksCommand("/hooks remove posttool 1", state(store));
  expect(again.ok).toBe(false);
});

test("turn hook edits leave the tool hooks in the file alone", async () => {
  const { root, store } = project({ preToolCommand: "guard" });
  await handleHooksCommand('/hooks add pre "echo hi"', {
    pre: store.pre,
    post: store.post,
    source: store,
  });
  expect(saved(root)).toEqual({ preToolCommand: "guard", preTurnCommand: ["echo hi"] });
});

test("/hooks lists the tool hooks", async () => {
  const { store } = project({ postToolCommand: [{ command: "x", tools: ["files"] }] });
  const listing = await handleHooksCommand("/hooks", state(store));
  expect(listing.ok && listing.value).toContain("post-tool hooks");
  expect(listing.ok && listing.value).toContain("x  [tools: files]");
});
