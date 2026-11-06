import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile, loadProfileTools } from "./load-profile.ts";

test("loads the text below a profile's header, and refuses a missing or empty profile", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-profile-"));
  await mkdir(join(root, "notes", "profile"), { recursive: true });
  await writeFile(join(root, "notes", "profile", "terse.md"), "---\nname: terse\ncategory: profile\nsummary:\n---\nBe brief.\n");
  await writeFile(join(root, "notes", "profile", "blank.md"), "---\nname: blank\ncategory: profile\nsummary:\n---\n\n");
  const load = loadProfile(root);
  expect(await load("terse")).toEqual({ ok: true, value: "Be brief." });
  expect((await load("blank")).ok).toBe(false);
  expect((await load("missing")).ok).toBe(false);
});

test("reads a profile's tools line, and refuses one that names a tool that does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-profile-tools-"));
  await mkdir(join(root, "notes", "profile"), { recursive: true });
  await writeFile(join(root, "notes", "profile", "reader.md"), "---\nname: reader\ncategory: profile\nsummary:\ntools: list_files\n---\nRead only.\n");
  await writeFile(join(root, "notes", "profile", "typo.md"), "---\nname: typo\ncategory: profile\nsummary:\ntools: list_fils\n---\nBody.\n");
  const tools = loadProfileTools(root);
  expect(await tools("reader")).toEqual({ ok: true, value: ["list_files"] });
  expect((await tools("typo")).ok).toBe(false);
});
