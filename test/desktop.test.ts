import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logToFile, windowMode } from "../src/web/desktop.ts";

test("from source the window opens only on request", () => {
  expect(windowMode(["bun", "main.ts"])).toBe(false);
  expect(windowMode(["bun", "main.ts", "--window"])).toBe(true);
});

test("console output goes to the log file", () => {
  const saved = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  const path = join(mkdtempSync(join(tmpdir(), "vise-log-")), "vise.log");
  try {
    logToFile(path);
    console.log("hello", { a: 1 });
    console.error("bad");
  } finally {
    Object.assign(console, saved);
  }
  const text = readFileSync(path, "utf8");
  expect(text).toContain("info hello");
  expect(text).toContain("error bad");
});
