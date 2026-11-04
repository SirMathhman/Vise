import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFile } from "./create-file.ts";

test("creates a new file with its missing folders, and never overwrites an existing one", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-create-"));
  expect(await createFile(root, join("a", "b", "new.txt"), "hello")).toEqual({
    ok: true,
    value: `created ${join("a", "b", "new.txt")}`,
  });
  expect(await readFile(join(root, "a", "b", "new.txt"), "utf8")).toBe("hello");
  await writeFile(join(root, "kept.txt"), "original");
  const again = await createFile(root, "kept.txt", "replaced");
  expect(again.ok).toBe(false);
  expect(await readFile(join(root, "kept.txt"), "utf8")).toBe("original");
});
