import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runnerPath } from "../../packages/backend/src/browser/chromium/playwright.ts";
import { runMaintenance } from "../../packages/backend/src/build/maintenance.ts";

test("the runner is used where it is when run from source", () => {
  expect(runnerPath("C:/repo/src/browser/chromium/playwright-runner.mjs", "unused", false)).toBe(
    "C:/repo/src/browser/chromium/playwright-runner.mjs",
  );
});

test("an embedded runner is written out once, per version, for node to read", () => {
  const root = mkdtempSync(join(tmpdir(), "vise-pack-"));
  const embedded = join(root, "~BUN", "runner.mjs");
  mkdirSync(join(root, "~BUN"));
  writeFileSync(embedded, "export {};");
  const home = join(root, "home");
  const first = runnerPath(embedded, home, true);
  expect(first).toContain(join(home, "runtime"));
  expect(readFileSync(first, "utf8")).toBe("export {};");
  writeFileSync(embedded, "changed");
  expect(readFileSync(runnerPath(embedded, home, true), "utf8")).toBe("export {};");
});

test("only the maintenance flags stop Vise from starting", async () => {
  expect(await runMaintenance(["bun", "index.ts", "--no-folder"])).toBe(false);
  expect(await runMaintenance(["bun", "index.ts", "--version"])).toBe(true);
});

describe("worker entries", () => {
  // In the compiled exe a worker is found relative to the folder the entry points share,
  // not to the file that spawns it; a mismatch only shows when the worker starts.
  const build = readFileSync("scripts/build-exe.ts", "utf8");
  for (const [spawner, worker] of [
    ["apps/web/src/desktop/desktop.ts", "apps/web/src/desktop/window-worker.ts"],
    ["apps/web/src/terminal/pty.ts", "apps/web/src/terminal/pty-reader-worker.ts"],
  ] as const) {
    test(`${worker} is an entry point named by its compiled Worker literal`, () => {
      const literal = /new Worker\("([^"]+)"\)/.exec(readFileSync(spawner, "utf8"))?.[1];
      expect(build).toContain(`"${worker}"`);
      expect(literal).toBe(`./${posix.relative("apps/web/src", worker)}`);
    });
  }
});
