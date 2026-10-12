import { expect, test } from "bun:test";
import { CHUNK_CHARS, CHUNK_LINES, CHUNK_OVERLAP, chunkFile } from "../../src/stores/semantic/chunk.ts";

const lines = (n: number, text = (i: number) => `line ${i}`): string =>
  Array.from({ length: n }, (_, i) => text(i)).join("\n");

test("a short file is one chunk covering all its lines", () => {
  const chunks = chunkFile(lines(10));
  expect(chunks).toHaveLength(1);
  expect(chunks[0]).toMatchObject({ start: 0, end: 9 });
});

test("an empty or blank file has no chunks", () => {
  expect(chunkFile("")).toEqual([]);
  expect(chunkFile("\n\n   \n")).toEqual([]);
});

test("a long file is cut into overlapping windows that cover every line", () => {
  const chunks = chunkFile(lines(130));
  expect(chunks[0]).toMatchObject({ start: 0, end: CHUNK_LINES - 1 });
  expect(chunks[1]?.start).toBe(CHUNK_LINES - CHUNK_OVERLAP);
  const covered = new Set<number>();
  for (const c of chunks) for (let i = c.start; i <= c.end; i++) covered.add(i);
  expect(covered.size).toBe(130);
  expect(chunks.at(-1)?.end).toBe(129);
});

test("a window cut short by the character limit still moves forward and leaves no line out", () => {
  const long = lines(60, () => "x".repeat(300)); // 5 lines fit a window
  const chunks = chunkFile(long);
  for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(CHUNK_CHARS + 301);
  const covered = new Set<number>();
  for (const c of chunks) for (let i = c.start; i <= c.end; i++) covered.add(i);
  expect(covered.size).toBe(60);
  for (let i = 1; i < chunks.length; i++) {
    expect(chunks[i]?.start).toBeGreaterThan(chunks[i - 1]?.start ?? 0);
  }
});

test("one enormous line is a chunk of its own, cut to a bounded size", () => {
  const chunks = chunkFile(`short\n${"y".repeat(50_000)}\nshort`);
  expect(chunks.length).toBeGreaterThan(0);
  for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(4000);
});
