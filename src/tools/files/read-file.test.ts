import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileLines } from "./read-file.ts";

test("returns the requested lines, clamps to the end of the file, and reports a start past it", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-read-"));
  await writeFile(join(root, "f.txt"), "a\nb\nc\n");
  expect(await readFileLines(root, "f.txt", 2, 3)).toEqual({
    ok: true,
    value: "b\nc",
  });
  expect(await readFileLines(root, "f.txt", 2, 10)).toEqual({
    ok: true,
    value: "b\nc\n[end of file: 3 lines]",
  });
  expect(await readFileLines(root, "f.txt", 5, 6)).toEqual({
    ok: true,
    value: "[the file has 3 lines]",
  });
});

test("cuts a range longer than 500 lines and says where to continue", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-read-"));
  const lines = Array.from({ length: 600 }, (_, index) => `line ${index + 1}`);
  await writeFile(join(root, "big.txt"), lines.join("\n"));
  const result = await readFileLines(root, "big.txt", 1, 600);
  expect(result.ok).toBe(true);
  if (result.ok) {
    const shown = result.value.split("\n");
    expect(shown.length).toBe(501);
    expect(shown.at(-1)).toBe(
      "[truncated at 500 lines; continue with start=501]",
    );
  }
});

test("refuses a file reached through a link to a hidden folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-read-"));
  await mkdir(join(root, ".hid"));
  await writeFile(join(root, ".hid", "s.txt"), "hidden secret\n");
  await symlink(join(root, ".hid"), join(root, "visible"), "junction");
  const result = await readFileLines(root, join("visible", "s.txt"), 1, 1);
  expect(result.ok).toBe(false);
});
