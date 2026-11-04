import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listFiles } from "./list-files.ts";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "vise-list-"));
  await writeFile(join(root, "a.txt"), "");
  await writeFile(join(root, ".secret"), "");
  await mkdir(join(root, "sub", "deep"), { recursive: true });
  await writeFile(join(root, "sub", "b.txt"), "");
  await writeFile(join(root, "sub", "deep", "c.txt"), "");
  return root;
}

test("lists files to the given depth, skipping hidden entries, and refuses paths outside the root", async () => {
  const root = await fixture();
  const shallow = await listFiles(root, ".", 1);
  const deeper = await listFiles(root, ".", 2);
  expect(shallow).toEqual({ ok: true, value: "a.txt" });
  expect(deeper).toEqual({ ok: true, value: ["a.txt", join("sub", "b.txt")].join("\n") });
  const outside = await listFiles(root, "..", 1);
  expect(outside.ok).toBe(false);
});
