import { expect, test } from "bun:test";
import type {
  SemanticHit,
  SemanticIndexPort,
  SemanticStatus,
} from "../../packages/backend/src/repl/ports.ts";
import { tools } from "../../packages/backend/src/tools.ts";
import { makeSemanticSearchHandler } from "../../packages/backend/src/tools/semantic/semantic-search.ts";

const hit = (path: string, score: number): SemanticHit => ({
  path,
  startLine: 10,
  endLine: 30,
  score,
  snippet: "line one\nline two",
});

function port(status: Partial<SemanticStatus>, hits: SemanticHit[]) {
  const asked: number[] = [];
  const full: SemanticStatus = { state: "ready", files: 2, chunks: 5, model: "m", ...status };
  const index: SemanticIndexPort = {
    search: async (_q, limit) => {
      asked.push(limit);
      return { ok: true, value: hits };
    },
    status: () => full,
    update: async () => ({ ok: true, value: { indexed: 0, skipped: 0, removed: 0, failed: 0 } }),
    onChange: () => () => undefined,
  };
  return { index, asked };
}

test("the tool is a deferred, file-system, files-category tool the model can look up", () => {
  const def = tools.find((t) => t.function.name === "semantic_search");
  expect(def).toBeDefined();
  expect(def?.deferred).toBe(true);
  expect(def?.requiresFileSystem).toBe(true);
  expect(def?.category).toBe("files");
  expect(def?.display?.label).toBeTruthy();
  const search = tools.find((t) => t.function.name === "search_files");
  expect(search?.function.description).toContain("semantic_search");
});

test("hits come back as path:lines (score) with the start of the passage", async () => {
  const { index, asked } = port({}, [hit("src/a.ts", 0.9123), hit("src/b.ts", 0.5)]);
  const text = await makeSemanticSearchHandler(index)({ query: "how are sessions saved" });
  expect(text).toContain("src/a.ts:10-30 (score 0.91)");
  expect(text).toContain("line one");
  expect(asked).toEqual([5]);
});

test("limit is a number the model may send as text and is kept between 1 and 10", async () => {
  const { index, asked } = port({}, [hit("a.ts", 1)]);
  const run = makeSemanticSearchHandler(index);
  await run({ query: "x", limit: "3" });
  await run({ query: "x", limit: 99 });
  await run({ query: "x", limit: 0 });
  expect(asked).toEqual([3, 10, 1]);
  expect((await run({ query: "x", limit: "many" })).startsWith("error:")).toBe(true);
});

test("a missing query is an error", async () => {
  const { index } = port({}, []);
  expect(await makeSemanticSearchHandler(index)({})).toBe("error: 'query' is required");
});

test("every way it cannot answer says so and names the fallback", async () => {
  const unavailable = port({ state: "unavailable", reason: "set VISE_EMBEDDING_MODEL" }, []);
  const a = await makeSemanticSearchHandler(unavailable.index)({ query: "x" });
  expect(a.startsWith("error:")).toBe(true);
  expect(a).toContain("search_files");

  const empty = port({ state: "empty", files: 0, chunks: 0 }, []);
  const b = await makeSemanticSearchHandler(empty.index)({ query: "x" });
  expect(b.startsWith("error:")).toBe(true);
  expect(b).toContain("/embed");

  const indexing = port({ state: "indexing", done: 2, total: 8 }, []);
  const c = await makeSemanticSearchHandler(indexing.index)({ query: "x" });
  expect(c.startsWith("error:")).toBe(false);
  expect(c).toContain("2/8");

  const none = port({}, []);
  expect(await makeSemanticSearchHandler(none.index)({ query: "xyz" })).toBe(
    "no semantic matches for 'xyz'",
  );
});
