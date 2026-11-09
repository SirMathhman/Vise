import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { undoStore } from "./undo-files.ts";

// A change that writes the file, as edit_file or create_file does.
function writeChange(path: string, text: string): () => Promise<string> {
  return async () => {
    await writeFile(path, text, "utf8");
    return "wrote";
  };
}

test("a revert puts a file back to where it was at the start of the turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-undo-"));
  const path = join(root, "f.txt");
  const store = undoStore(root);
  store.startTurn();
  await store.around("f.txt", writeChange(path, "one"));
  store.startTurn();
  await store.around("f.txt", writeChange(path, "two"));
  expect(store.points()).toEqual([1, 2]);
  expect(await store.revert(1)).toEqual({ ok: true, value: ["f.txt"] });
  expect(await readFile(path, "utf8")).toBe("one");
  // The file did not exist before the first turn, so the next revert removes it.
  expect(await store.revert(1)).toEqual({ ok: true, value: ["f.txt"] });
  await expect(readFile(path, "utf8")).rejects.toThrow();
});

test("a file changed outside Vise is never overwritten, and nothing is undone", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-undo-"));
  const path = join(root, "f.txt");
  const store = undoStore(root);
  store.startTurn();
  await store.around("f.txt", writeChange(path, "one"));
  await writeFile(path, "mine", "utf8");
  const reverted = await store.revert(1);
  expect(reverted.ok).toBe(false);
  expect(await readFile(path, "utf8")).toBe("mine");
});

test("a revert to a point that is not kept is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-undo-"));
  const store = undoStore(root);
  store.startTurn();
  const reverted = await store.revert(4);
  expect(reverted.ok).toBe(false);
});
