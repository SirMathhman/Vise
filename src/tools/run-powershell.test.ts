import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPowershell } from "./run-powershell.ts";

test("runs the command in the given directory and returns its output and exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "Write-Output hello");
  expect(result).toEqual({ ok: true, value: "hello\n[exit code 0]" });
});

test("cuts output longer than 500 lines and says so", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "1..600");
  expect(result.ok).toBe(true);
  if (result.ok) {
    const shown = result.value.split("\n");
    expect(shown.at(-2)).toBe("[output cut at 500 lines]");
    expect(shown.at(-1)).toBe("[exit code 0]");
  }
});
