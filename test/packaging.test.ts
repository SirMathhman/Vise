import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runnerPath } from "../src/browser/playwright.ts";
import { runMaintenance } from "../src/build/maintenance.ts";

test("the runner is used where it is when run from source", () => {
  expect(
    runnerPath("C:/repo/src/browser/playwright-runner.mjs", "unused", false),
  ).toBe("C:/repo/src/browser/playwright-runner.mjs");
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
  expect(readFileSync(runnerPath(embedded, home, true), "utf8")).toBe(
    "export {};",
  );
});

test("only the maintenance flags stop Vise from starting", async () => {
  expect(await runMaintenance(["bun", "index.ts", "--no-folder"])).toBe(false);
  expect(await runMaintenance(["bun", "index.ts", "--version"])).toBe(true);
});
