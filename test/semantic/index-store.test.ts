import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllDbs } from "../../packages/backend/src/db/open.ts";
import { IndexStore } from "../../packages/backend/src/stores/semantic/index-store.ts";

afterAll(() => closeAllDbs());

function store(): IndexStore {
  const opened = IndexStore.open(mkdtempSync(join(tmpdir(), "vise-index-")));
  if (!opened.ok) throw new Error("could not open");
  return opened.value;
}

const chunk = (start: number, end: number, content: string) => ({ start, end, content });

test("a file's chunks are replaced as a whole and read back with their line ranges", () => {
  const s = store();
  expect(
    s.replaceFile(
      "a.ts",
      [chunk(0, 9, "one"), chunk(8, 20, "two")],
      [
        [1, 0],
        [0, 1],
      ],
      "m1",
      100,
    ).ok,
  ).toBe(true);
  expect(s.replaceFile("a.ts", [chunk(0, 4, "only")], [[1, 1]], "m1", 200).ok).toBe(true);
  const files = s.files();
  expect(files.ok && files.value).toEqual([{ path: "a.ts", mtimeMs: 200, model: "m1" }]);
  const chunks = s.chunks("m1");
  expect(chunks.ok && chunks.value.map((c) => [c.path, c.startLine, c.endLine, c.content])).toEqual(
    [["a.ts", 0, 4, "only"]],
  );
});

test("chunks of another model are counted apart and never returned for a search", () => {
  const s = store();
  s.replaceFile("a.ts", [chunk(0, 1, "x")], [[1, 0]], "old", 1);
  s.replaceFile("b.ts", [chunk(0, 1, "y")], [[0, 1]], "new", 1);
  const totals = s.totals("new");
  expect(totals.ok && totals.value).toEqual({ files: 1, chunks: 1, otherModelChunks: 1 });
  const chunks = s.chunks("new");
  expect(chunks.ok && chunks.value.map((c) => c.path)).toEqual(["b.ts"]);
});

test("removed files and a clear take their chunks with them, and a cached read is not stale", () => {
  const s = store();
  s.replaceFile("a.ts", [chunk(0, 1, "x")], [[1, 0]], "m", 1);
  s.replaceFile("b.ts", [chunk(0, 1, "y")], [[0, 1]], "m", 1);
  expect((s.chunks("m") as { value: unknown[] }).value).toHaveLength(2);
  s.removeFiles(["a.ts"]);
  expect((s.chunks("m") as { value: unknown[] }).value).toHaveLength(1);
  s.clear();
  expect((s.chunks("m") as { value: unknown[] }).value).toHaveLength(0);
});
