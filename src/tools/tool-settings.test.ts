import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readToolSettings, saveToolSettings } from "./tool-settings.ts";

test("a saved list of switched-off tools is read back, and a missing file switches none off", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-settings-"));
  expect(await readToolSettings(root)).toEqual({ ok: true, value: [] });
  expect(await saveToolSettings(root, ["edit_file", "kill_command"])).toEqual({
    ok: true,
    value: undefined,
  });
  expect(await readToolSettings(root)).toEqual({
    ok: true,
    value: ["edit_file", "kill_command"],
  });
});

test("refuses a settings file that is not JSON or names a tool that does not exist", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-settings-"));
  await mkdir(join(root, ".vise"), { recursive: true });
  await writeFile(join(root, ".vise", "tools.json"), "{ nope");
  expect((await readToolSettings(root)).ok).toBe(false);
  await writeFile(
    join(root, ".vise", "tools.json"),
    '{"disabled":["no_such_tool"]}',
  );
  expect((await readToolSettings(root)).ok).toBe(false);
});
