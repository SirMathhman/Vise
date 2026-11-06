import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "../../core/result.ts";
import { readModelSetting } from "./model-settings.ts";
import { selectModel } from "./select-model.ts";

const listing = async () => ok([{ id: "a/one", contextLength: 1000 }]);

test("an unlisted name is refused, and nothing is saved or switched", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-select-"));
  const switched: string[] = [];
  const result = await selectModel({
    root,
    list: listing,
    name: "b/two",
    setModel: (model) => switched.push(model),
  });
  expect(result.ok).toBe(false);
  expect(switched).toEqual([]);
  expect(await readModelSetting(root)).toEqual({ ok: true, value: undefined });
});

test("a choice that cannot be saved does not switch the model", async () => {
  const dir = await mkdtemp(join(tmpdir(), "vise-select-"));
  const notAFolder = join(dir, "file.txt");
  await writeFile(notAFolder, "x");
  const switched: string[] = [];
  const result = await selectModel({
    root: notAFolder,
    list: listing,
    name: "a/one",
    setModel: (model) => switched.push(model),
  });
  expect(result.ok).toBe(false);
  expect(switched).toEqual([]);
});

test("a listed name is saved, then switched to", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-select-"));
  const switched: string[] = [];
  const result = await selectModel({
    root,
    list: listing,
    name: "a/one",
    setModel: (model) => switched.push(model),
  });
  expect(result).toEqual({ ok: true, value: "a/one" });
  expect(switched).toEqual(["a/one"]);
  expect(await readModelSetting(root)).toEqual({ ok: true, value: "a/one" });
});
