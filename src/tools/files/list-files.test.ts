import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
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

test("refuses a link inside the root that points outside it", async () => {
  const root = await fixture();
  const elsewhere = await mkdtemp(join(tmpdir(), "vise-outside-"));
  await writeFile(join(elsewhere, "leak.txt"), "");
  await symlink(elsewhere, join(root, "link"), "junction");
  const result = await listFiles(root, "link", 1);
  expect(result.ok).toBe(false);
});

test("refuses a link inside the root that points at a hidden folder", async () => {
  const root = await fixture();
  await mkdir(join(root, ".hid"));
  await writeFile(join(root, ".hid", "s.txt"), "");
  await symlink(join(root, ".hid"), join(root, "visible"), "junction");
  const result = await listFiles(root, "visible", 1);
  expect(result.ok).toBe(false);
});
