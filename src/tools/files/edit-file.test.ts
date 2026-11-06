import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFile } from "./edit-file.ts";

test("replaces the first match and never creates a missing file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-edit-"));
  await writeFile(join(root, "f.txt"), "one two one");
  expect(await editFile(root, "f.txt", "one", "1")).toEqual({
    ok: true,
    value: "edited f.txt",
  });
  expect(await readFile(join(root, "f.txt"), "utf8")).toBe("1 two one");
  expect((await editFile(root, "f.txt", "missing", "x")).ok).toBe(false);
  expect((await editFile(root, "new.txt", "a", "b")).ok).toBe(false);
});
