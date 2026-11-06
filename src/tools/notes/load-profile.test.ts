import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadProfile } from "./load-profile.ts";

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
