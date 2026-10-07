import { describe, expect, test } from "bun:test";
import { listDir, readTextFile } from "../src/web/files.ts";

const root = process.cwd();

describe("web explorer files", () => {
  test("lists directories before files", () => {
    const r = listDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const first = r.value.entries.findIndex((e) => !e.dir);
    expect(r.value.entries.slice(first).some((e) => e.dir)).toBe(false);
  });

  test("rejects paths outside the root", () => {
    expect(listDir(root, "..").ok).toBe(false);
    expect(readTextFile(root, "../package.json").ok).toBe(false);
    expect(readTextFile(root, "C:/Windows/win.ini").ok).toBe(false);
  });

  test("reads a text file", () => {
    const r = readTextFile(root, "package.json");
    expect(r.ok && r.value.includes('"name"')).toBe(true);
  });
});
