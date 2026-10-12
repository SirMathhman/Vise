import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installExe } from "../../scripts/install-exe.ts";
import { selfKillRefusal } from "../../packages/backend/src/tools/self-kill-guard.ts";

test("installExe swaps the new exe in and keeps the old one aside", () => {
  const dir = mkdtempSync(join(tmpdir(), "vise-install-"));
  const final = join(dir, "vise.exe");
  const next = join(dir, "vise.next.exe");
  writeFileSync(final, "old");
  writeFileSync(next, "new");
  expect(installExe(next, final)).toBe(true);
  expect(readFileSync(final, "utf8")).toBe("new");
  expect(readdirSync(dir).filter((n) => n.endsWith(".old"))).toHaveLength(1);
  // a second build clears the earlier leftover
  writeFileSync(next, "newer");
  installExe(next, final);
  expect(readdirSync(dir).filter((n) => n.endsWith(".old"))).toHaveLength(1);
});

test("installExe works when there is no previous exe", () => {
  const dir = mkdtempSync(join(tmpdir(), "vise-install-"));
  writeFileSync(join(dir, "a.next.exe"), "x");
  expect(installExe(join(dir, "a.next.exe"), join(dir, "a.exe"))).toBe(false);
});

test("self-kill guard refuses killing vise, bun or own pid only", () => {
  expect(selfKillRefusal("taskkill /F /IM vise.exe", [1])).toBeDefined();
  expect(selfKillRefusal("Stop-Process -Name bun", [1])).toBeDefined();
  expect(selfKillRefusal("Stop-Process -Id 4242", [4242])).toBeDefined();
  expect(selfKillRefusal("Stop-Process -Name notepad", [1])).toBeUndefined();
  expect(selfKillRefusal("bun run build:exe", [1])).toBeUndefined();
});

test("the logo ico has six well-formed PNG frames", () => {
  const b = readFileSync("assets/icon.ico");
  expect(b.readUInt16LE(2)).toBe(1);
  const n = b.readUInt16LE(4);
  expect(n).toBe(6);
  for (let i = 0; i < n; i++) {
    const e = 6 + i * 16;
    const at = b.readUInt32LE(e + 12);
    expect(b.subarray(at, at + 8).toString("hex")).toBe("89504e470d0a1a0a");
  }
});
