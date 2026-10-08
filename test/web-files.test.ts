import { describe, expect, test } from "bun:test";
import { annotateIgnored, isGitRoot, listDir, readTextFile, type DirEntry } from "../src/web/files.ts";

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

  test("isGitRoot detects this repo", () => {
    expect(isGitRoot(root)).toBe(true);
    expect(isGitRoot("C:/nonexistent-path-xyz")).toBe(false);
  });

  test("annotateIgnored returns unchanged for empty entries", () => {
    const entries: DirEntry[] = [];
    expect(annotateIgnored(root, "", entries)).toBe(entries);
  });

  test("annotateIgnored marks gitignored entries", () => {
    const r = listDir(root, "");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const entries = annotateIgnored(root, "", r.value.entries);
    const nodeModules = entries.find((e) => e.name === "node_modules");
    expect(nodeModules?.ignored).toBe(true);
    const src = entries.find((e) => e.name === "src");
    expect(src?.ignored).toBeFalsy();
  });
});
