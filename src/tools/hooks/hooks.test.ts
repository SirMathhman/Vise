import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hookRunner, readHooks } from "./hooks.ts";

test("a missing hooks file has no hooks, and a file that lists a point wrongly is refused", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-hooks-"));
  expect(await readHooks(root)).toEqual({
    ok: true,
    value: { sessionStart: [], sessionEnd: [], turnStart: [], turnEnd: [] },
  });
  await mkdir(join(root, ".vise"), { recursive: true });
  await writeFile(join(root, ".vise", "hooks.json"), '{"turnStart":"not a list"}');
  expect((await readHooks(root)).ok).toBe(false);
});

test("runs the commands of a point and returns their output, and a failing command is an error", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-hooks-"));
  const passing = hookRunner(root, {
    sessionStart: ["Write-Output hello"],
    sessionEnd: [],
    turnStart: [],
    turnEnd: [],
  });
  const output = await passing("sessionStart");
  expect(output.ok && output.value).toContain("hello");
  const failing = hookRunner(root, { sessionStart: [], sessionEnd: [], turnStart: ["exit 3"], turnEnd: [] });
  expect((await failing("turnStart")).ok).toBe(false);
});

test("a point runs the global commands first, then the profile's", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-hooks-"));
  const runner = hookRunner(root, { sessionStart: [], sessionEnd: [], turnStart: [], turnEnd: ["Write-Output global"] });
  const output = await runner("turnEnd", ["Write-Output profile"]);
  expect(output.ok && output.value.indexOf("global")).toBeLessThan(output.ok ? output.value.indexOf("profile") : 0);
  expect(output.ok && output.value).toContain("profile");
});
