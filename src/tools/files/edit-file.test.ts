import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editFile, editPreview, planEdit } from "./edit-file.ts";

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

test("the plan counts every match and gives the line of the first, with CRLF line endings too", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-edit-"));
  await writeFile(join(root, "f.txt"), "a\r\nx\r\nx\r\nx\r\n");
  const plan = await planEdit(root, "f.txt", "x");
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(plan.value.matches).toBe(3);
  expect(plan.value.line).toBe(2);
  expect(editPreview(plan.value, "y")).toContain("found 3 matches; the first starts at line 2");
});

test("the question says '1 match' when there is one", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-edit-"));
  await writeFile(join(root, "f.txt"), "only x here");
  const plan = await planEdit(root, "f.txt", "x");
  expect(plan.ok).toBe(true);
  if (!plan.ok) return;
  expect(editPreview(plan.value, "y")).toContain("found 1 match; the first starts at line 1");
});
