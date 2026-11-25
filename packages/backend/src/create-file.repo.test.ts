import { beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCreateFile } from "./create-file";

// A throwaway git repository with an ignored folder, an existing file, and a folder that
// links out of the project (where the OS allows links).
let root = "";
let outside = "";
let linkCreated = false;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "vise-create-"));
  outside = mkdtempSync(path.join(tmpdir(), "vise-outside-"));
  writeFileSync(path.join(root, ".gitignore"), "build/\n");
  writeFileSync(path.join(root, "existing.txt"), "keep me");
  try {
    symlinkSync(outside, path.join(root, "escape"), "junction");
    linkCreated = true;
  } catch {
    linkCreated = false;
  }
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
});

const propose = (p: string, content: string) =>
  runCreateFile(root, JSON.stringify({ path: p, content }));

describe("runCreateFile in a git repository", () => {
  test("creates a new file once the approval is granted", async () => {
    const outcome = await propose("notes/new.txt", "hello\nworld");
    expect(typeof outcome).toBe("object");
    if (typeof outcome === "string") {
      throw new Error(outcome);
    }
    expect(outcome.body).toBe("+ hello\n+ world");
    expect(await outcome.apply()).toBe("Created notes/new.txt.");
    expect(readFileSync(path.join(root, "notes/new.txt"), "utf8")).toBe(
      "hello\nworld",
    );
  });

  test("refuses a path that already exists", async () => {
    expect(await propose("existing.txt", "x")).toBe(
      '"existing.txt" already exists; this tool never overwrites a file.',
    );
  });

  test("refuses a path git ignores", async () => {
    expect(await propose("build/out.txt", "x")).toBe(
      'git ignores "build/out.txt", so it cannot be created.',
    );
  });

  test("refuses a path outside the project", async () => {
    expect(await propose("../elsewhere.txt", "x")).toBe(
      "The path must be inside the project",
    );
  });

  test("refuses git's own folder, where hooks would run", async () => {
    expect(await propose(".git/hooks/pre-commit", "#!/bin/sh\necho hi")).toBe(
      "Git's own folder cannot be written to.",
    );
  });

  test("refuses a folder that links out of the project", async () => {
    if (!linkCreated) {
      return;
    }
    expect(await propose("escape/new.txt", "x")).toBe(
      "The folder must stay inside the project.",
    );
    expect(existsSync(path.join(outside, "new.txt"))).toBe(false);
  });
});
