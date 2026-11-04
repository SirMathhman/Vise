import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killAllJobs, killJob, readJob } from "./jobs.ts";
import { runPowershell } from "./run-powershell.ts";

afterEach(async () => {
  await killAllJobs();
});

test("runs the command in the given directory and returns its output and exit code", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "Write-Output hello");
  expect(result).toEqual({ ok: true, value: "hello\n[exit code 0]" });
});

test("cuts output longer than 500 lines, keeping the last 500", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "1..600");
  expect(result.ok).toBe(true);
  if (result.ok) {
    const shown = result.value.split("\n");
    expect(shown[0]).toBe("[earlier output cut; last 500 lines shown]");
    expect(shown.at(-2)).toBe("600");
    expect(shown.at(-1)).toBe("[exit code 0]");
    expect(shown.length).toBe(502);
  }
});

test("keeps stderr when stdout is long", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "1..600; [Console]::Error.WriteLine('boom-stderr')");
  expect(result.ok && result.value.includes("boom-stderr")).toBe(true);
});

test("a command still running at the timeout becomes a background job that can be killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const started = Date.now();
  const result = await runPowershell(root, "Write-Output started; Start-Sleep 20; 'late'", 1000);
  expect(Date.now() - started).toBeLessThan(10_000);
  const match = result.ok ? /as job (\d+)/.exec(result.value) : null;
  expect(match).not.toBeNull();
  const id = Number(match?.[1]);
  const running = readJob(id);
  expect(running.ok && running.value.includes("running")).toBe(true);
  expect(running.ok && running.value.includes("started")).toBe(true);
  expect(await killJob(id)).toEqual({ ok: true, value: `job ${id} stopped` });
  const killed = readJob(id);
  expect(killed.ok && killed.value.startsWith(`job ${id}: killed`)).toBe(true);
});

test("returns at the timeout even when a child process keeps the output open", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const started = Date.now();
  const result = await runPowershell(root, "& cmd /c 'ping -n 60 127.0.0.1 > nul'", 1000);
  expect(result.ok && result.value.includes("still running after 1 seconds as job")).toBe(true);
  expect(Date.now() - started).toBeLessThan(10_000);
});

test("cuts one overlong line so memory stays bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "'x' * 50000");
  expect(result.ok && result.value.includes("[line cut]")).toBe(true);
  expect(result.ok && result.value.length < 10_000).toBe(true);
});

test("reports a job whose stop keeps failing, so it can be warned about", async () => {
  const root = await mkdtemp(join(tmpdir(), "vise-ps-"));
  const result = await runPowershell(root, "Start-Sleep 20", 1000);
  const match = result.ok ? /as job (\d+)/.exec(result.value) : null;
  expect(match).not.toBeNull();
  const unstopped = await killAllJobs(async () => false);
  try {
    expect(unstopped.map((job) => job.id)).toEqual([Number(match?.[1])]);
  } finally {
    // The real process is still running; stop it directly so the test leaves nothing behind, even when an assertion fails.
    await Bun.spawn(["taskkill", "/PID", String(unstopped[0]?.pid), "/T", "/F"], { stdout: "ignore", stderr: "ignore" }).exited;
  }
});
