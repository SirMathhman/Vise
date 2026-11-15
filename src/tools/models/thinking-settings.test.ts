import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_THINKING,
  readThinkingSetting,
  saveThinkingSetting,
} from "./thinking-settings.ts";

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), "vise-thinking-"));
}

test("with no saved level, thinking is on at the default", async () => {
  const root = await folder();
  expect(await readThinkingSetting(root)).toEqual({ ok: true, value: DEFAULT_THINKING });
  expect(DEFAULT_THINKING).toBe("low");
});

test("a saved level is read back, and off reads as undefined", async () => {
  const root = await folder();
  expect(await saveThinkingSetting(root, "high")).toEqual({ ok: true, value: undefined });
  expect(await readThinkingSetting(root)).toEqual({ ok: true, value: "high" });
  await saveThinkingSetting(root, undefined);
  expect(await readFile(join(root, ".vise", "thinking.json"), "utf8")).toContain('"off"');
  expect(await readThinkingSetting(root)).toEqual({ ok: true, value: undefined });
});

test("a file that is not JSON, or names no known level, is an error", async () => {
  const root = await folder();
  await mkdir(join(root, ".vise"));
  await writeFile(join(root, ".vise", "thinking.json"), "{ nope");
  expect((await readThinkingSetting(root)).ok).toBe(false);
  await writeFile(join(root, ".vise", "thinking.json"), '{"thinking":"max"}');
  expect((await readThinkingSetting(root)).ok).toBe(false);
});

test("a file that is valid JSON but names no level is an error", async () => {
  const root = await folder();
  await mkdir(join(root, ".vise"));
  await writeFile(join(root, ".vise", "thinking.json"), "{}");
  expect((await readThinkingSetting(root)).ok).toBe(false);
});
