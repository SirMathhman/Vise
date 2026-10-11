import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolDetail } from "../../src/output/tool-line.ts";
import { numberArg } from "../../src/tools/args.ts";
import { createFile, readFile } from "../../src/tools/files.ts";

const bigFile = (): string => {
  const path = join(mkdtempSync(join(tmpdir(), "vise-read-")), "big.txt");
  writeFileSync(
    path,
    Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n"),
  );
  return path;
};

test("a number sent as text counts as that number", () => {
  expect(numberArg("750")).toBe(750);
  expect(numberArg(" 12 ")).toBe(12);
  expect(numberArg(5)).toBe(5);
  expect(numberArg(undefined)).toBeUndefined();
  expect(Number.isNaN(numberArg("abc"))).toBe(true);
});

test("a range given as text reads that range, not the start of the file", () => {
  const path = bigFile();
  const asNumbers = readFile({ path, offset: 300, limit: 5 });
  const asText = readFile({ path, offset: "300", limit: "5" });
  expect(asText).toBe(asNumbers);
  expect(asText.startsWith("[lines 300-304 of 600]")).toBe(true);
  expect(asText).toContain("line 300");
  expect(asText).not.toContain("line 1\n");
});

test("an argument that is not a number is refused, not ignored", () => {
  const path = bigFile();
  expect(readFile({ path, offset: "the middle" })).toBe(
    'error: offset must be a number (got "the middle")',
  );
});

test("the call line shows the range for a range given as text too", () => {
  expect(
    toolDetail({ path: "a.ts", offset: "300", limit: "5" }, "read_file"),
  ).toBe("a.ts · lines 300–304");
});

test("a missing path is refused, not read as an empty string", () => {
  expect(readFile({})).toBe("error: path is required");
  expect(createFile({})).toBe("error: path must not be empty");
});

test("a garbled limit is refused, not silently truncated", () => {
  const path = bigFile();
  expect(readFile({ path, limit: "30," })).toBe(
    'error: limit must be a number (got "30,")',
  );
});
