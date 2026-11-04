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

test("keeps stderr when stdout is long", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "1..600; [Console]::Error.WriteLine('boom-stderr')");
  expect(result.ok && result.value.includes("boom-stderr")).toBe(true);
});

test("stops a command that runs past its timeout", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const started = Date.now();
  const result = await runPowershell(root, "Start-Sleep 20; 'late'", 1000);
  expect(result).toEqual({ ok: true, value: "[stopped after 1 seconds]" });
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("returns at the timeout even when a child process keeps the output open", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const started = Date.now();
  const result = await runPowershell(root, "& cmd /c 'ping -n 60 127.0.0.1 > nul'", 1000);
  expect(result.ok && result.value.endsWith("[stopped after 1 seconds]")).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
});
