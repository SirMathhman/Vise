import { expect, test } from "bun:test";
import {
  formatSemanticHits,
  formatSemanticStatus,
} from "../../packages/backend/src/output/semantic-format.ts";
import {
  handleEmbed,
  handleSearch,
} from "../../packages/backend/src/repl/commands/search-command.ts";
import type {
  SemanticHit,
  SemanticIndexPort,
  SemanticStatus,
  SemanticUpdateStats,
  SessionCommands,
} from "../../packages/backend/src/repl/ports.ts";

const hit: SemanticHit = {
  path: "src/auth.ts",
  startLine: 12,
  endLine: 40,
  score: 0.8312,
  snippet: "export function login() {\n  // check the password\n  return true;\n  extra line",
};

function fake(status: Partial<SemanticStatus> = {}, hits: SemanticHit[] = [hit]) {
  const calls: string[] = [];
  const full: SemanticStatus = {
    state: "ready",
    files: 3,
    chunks: 9,
    model: "embedder",
    ...status,
  };
  const port: SemanticIndexPort = {
    search: async (query, limit) => {
      calls.push(`search:${query}:${limit}`);
      return { ok: true, value: hits };
    },
    status: () => full,
    update: async (options) => {
      calls.push(options?.rebuild ? "rebuild" : "update");
      const stats: SemanticUpdateStats = { indexed: 2, skipped: 1, removed: 0, failed: 0 };
      return { ok: true, value: stats };
    },
    onChange: () => () => undefined,
  };
  return { port, calls };
}

const sessions = {
  sessionSource: () => ({
    search: async () => ({ ok: true as const, value: [] }),
  }),
} as unknown as SessionCommands;

test("/search semantic <text> asks the index and shows path, lines, score and the passage", async () => {
  const { port, calls } = fake();
  const result = await handleSearch(sessions, port, "/search semantic how do I log in");
  expect(calls).toEqual(["search:how do I log in:8"]);
  expect(result.ok && result.value).toContain("src/auth.ts:12-40  (0.83)");
  expect(result.ok && result.value).toContain("check the password");
  expect(result.ok && result.value).not.toContain("extra line");
});

test("/search <text> stays the saved-sessions search", async () => {
  const { port, calls } = fake();
  await handleSearch(sessions, port, "/search login");
  expect(calls).toEqual([]);
});

test("a semantic search with no text, or without a folder, says so", async () => {
  const { port } = fake();
  const noText = await handleSearch(sessions, port, "/search semantic");
  expect(noText.ok).toBe(false);
  const noFolder = await handleSearch(sessions, undefined, "/search semantic login");
  expect(noFolder.ok).toBe(false);
});

test("empty results explain themselves by the index's state", () => {
  expect(formatSemanticHits("x", [], { state: "ready", files: 1, chunks: 1, model: "m" })).toBe(
    "no semantic matches for 'x'",
  );
  expect(
    formatSemanticHits("x", [], {
      state: "indexing",
      files: 1,
      chunks: 4,
      model: "m",
      done: 2,
      total: 9,
    }),
  ).toContain("2/9");
  expect(
    formatSemanticHits("x", [], { state: "empty", files: 0, chunks: 0, model: "m" }),
  ).toContain("/embed");
  expect(
    formatSemanticStatus({
      state: "unavailable",
      files: 0,
      chunks: 0,
      model: "m",
      reason: "set VISE_EMBEDDING_MODEL",
    }),
  ).toContain("VISE_EMBEDDING_MODEL");
});

test("/embed updates, /embed rebuild rebuilds, /embed status only reports, anything else is a usage error", async () => {
  const { port, calls } = fake();
  const updated = await handleEmbed(port, "/embed");
  expect(updated.ok && updated.value).toContain("2 indexed");
  await handleEmbed(port, "/embed rebuild");
  const status = await handleEmbed(port, "/embed status");
  expect(status.ok && status.value).toContain("index ready");
  expect(calls).toEqual(["update", "rebuild"]);
  const bad = await handleEmbed(port, "/embed nonsense");
  expect(bad.ok).toBe(false);
});

test("/embed while it is already indexing reports instead of queueing another run", async () => {
  const { port, calls } = fake({ state: "indexing", done: 3, total: 10 });
  const result = await handleEmbed(port, "/embed");
  expect(result.ok && result.value).toContain("3/10");
  expect(calls).toEqual([]);
});
