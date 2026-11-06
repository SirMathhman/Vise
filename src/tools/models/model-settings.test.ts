import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readModelSetting, saveModelSetting } from "./model-settings.ts";

test("a saved model is read back, a missing file has none, and a file that names no model is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-model-"));
  expect(await readModelSetting(root)).toEqual({ ok: true, value: undefined });
  expect(await saveModelSetting(root, "openai/gpt-x")).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await readModelSetting(root)).toEqual({
    ok: true,
    value: "openai/gpt-x",
  });
  await mkdir(join(root, ".vise"), { recursive: true });
  await writeFile(join(root, ".vise", "model.json"), '{"model":3}');
  expect((await readModelSetting(root)).ok).toBe(false);
});
