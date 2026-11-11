import { expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_WHOLE_BYTES, readFileLines, readWholeFile, readWholeVersioned, writeWholeText, writeWholeTextIfUnchanged } from "./read-file.ts";

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

test("a whole file is read as text, and a binary file or one over the size cap is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-whole-"));
  await writeFile(join(root, "a.txt"), "line one\nline two\n");
  await writeFile(join(root, "b.bin"), Buffer.from([1, 0, 2]));
  await writeFile(join(root, "big.txt"), "x".repeat(MAX_WHOLE_BYTES + 1));
  expect(await readWholeFile(root, "a.txt")).toEqual({ ok: true, value: "line one\nline two\n" });
  expect((await readWholeFile(root, "b.bin")).ok).toBe(false);
  expect((await readWholeFile(root, "big.txt")).ok).toBe(false);
  expect((await readWholeFile(root, "..")).ok).toBe(false);
});

test("a page save writes text to an existing text file, and refuses a binary file, a missing file, or text over the cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-save-"));
  await writeFile(join(root, "a.txt"), "old");
  await writeFile(join(root, "b.bin"), Buffer.from([1, 0, 2]));
  expect(await writeWholeText(root, "a.txt", "new text")).toEqual({ ok: true, value: undefined });
  expect(await readWholeFile(root, "a.txt")).toEqual({ ok: true, value: "new text" });
  expect((await writeWholeText(root, "b.bin", "x")).ok).toBe(false);
  expect((await writeWholeText(root, "missing.txt", "x")).ok).toBe(false);
  expect((await writeWholeText(root, "a.txt", "x".repeat(MAX_WHOLE_BYTES + 1))).ok).toBe(false);
});

test("a page save is refused when the file has changed since the version it was based on, and writes when it has not", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-version-"));
  await writeFile(join(root, "a.txt"), "first");
  const seen = await readWholeVersioned(root, "a.txt");
  expect(seen.ok).toBe(true);
  if (!seen.ok) return;
  await writeFile(join(root, "a.txt"), "changed outside");
  expect((await writeWholeTextIfUnchanged(root, "a.txt", "mine", seen.value.version)).ok).toBe(false);
  expect(await readWholeFile(root, "a.txt")).toEqual({ ok: true, value: "changed outside" });
  const fresh = await readWholeVersioned(root, "a.txt");
  expect(fresh.ok).toBe(true);
  if (!fresh.ok) return;
  const written = await writeWholeTextIfUnchanged(root, "a.txt", "mine", fresh.value.version);
  expect(written.ok).toBe(true);
  expect(await readWholeFile(root, "a.txt")).toEqual({ ok: true, value: "mine" });
});
