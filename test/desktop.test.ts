import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { logToFile, parseWindowEvent, windowMode } from "../src/web/desktop/desktop.ts";

test("what the window thread says is read strictly; anything odd is a failure", () => {
  expect(parseWindowEvent({ type: "ready" })).toEqual({ type: "ready" });
  expect(parseWindowEvent({ type: "closed" })).toEqual({ type: "closed" });
  expect(parseWindowEvent({ type: "failed", reason: "no runtime" })).toEqual({
    type: "failed",
    reason: "no runtime",
  });
  expect(parseWindowEvent({ type: "failed" }).type).toBe("failed");
  expect(parseWindowEvent("closed").type).toBe("failed");
  expect(parseWindowEvent(null).type).toBe("failed");
});

test("from source the window opens only on request", () => {
  expect(windowMode(["bun", "main.ts"])).toBe(false);
  expect(windowMode(["bun", "main.ts", "--window"])).toBe(true);
});

test("console output goes to the log file", () => {
  const saved = {
    log: console.log,
    error: console.error,
    warn: console.warn,
    info: console.info,
  };
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
