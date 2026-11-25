import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runReadFile } from "../../src/tools/read-file";

// A throwaway git repository with one tracked-or-visible file, one ignored file, a binary
// file, an oversized file, and (where the OS allows) a symbolic link.
let root = "";
let linkCreated = false;

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "vise-read-"));
  writeFileSync(path.join(root, ".gitignore"), "secret.txt\n");
  writeFileSync(path.join(root, "notes.txt"), "line one\nline two\n");
  writeFileSync(path.join(root, "secret.txt"), "hidden");
  writeFileSync(path.join(root, "image.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(path.join(root, "big.txt"), "x".repeat(2_100_000));
  try {
    symlinkSync(path.join(root, "notes.txt"), path.join(root, "link.txt"));
    linkCreated = true;
  } catch {
    linkCreated = false;
  }
  await Bun.spawn(["git", "init", "-q"], { cwd: root }).exited;
});

const call = (p: string, extra = "") =>
  runReadFile(root, `{"path":${JSON.stringify(p)}${extra}}`);

describe("runReadFile in a git repository", () => {
  test("reads a visible text file", async () => {
    expect(await call("notes.txt")).toContain("line one");
  });

  test("refuses a file git ignores", async () => {
    expect(await call("secret.txt")).toBe(
      '"secret.txt" is not a file in the project, or git ignores it.',
    );
  });

  test("refuses a path outside the root", async () => {
    expect(await call("../outside.txt")).toBe(
      "The path must be inside the project",
    );
  });

  test("refuses a binary file", async () => {
    expect(await call("image.bin")).toBe(
      "The file is binary and cannot be read as text.",
    );
  });

  test("refuses a file over the size limit", async () => {
    expect(await call("big.txt")).toBe("The file is too large to read.");
  });

  test("refuses a symbolic link", async () => {
    if (!linkCreated) {
      return;
    }
    expect(await call("link.txt")).toBe("Symbolic links are not followed.");
  });

  test("reports the lines it returned when a read is cut", async () => {
    const line = "y".repeat(100);
    writeFileSync(
      path.join(root, "long.txt"),
      Array.from({ length: 300 }, () => line).join("\n"),
    );
    const result = await call("long.txt");
    const header = result.split("\n")[0] ?? "";
    expect(header).toMatch(/^Lines 1-\d+ of 300:$/);
    expect(header).not.toBe("Lines 1-300 of 300:");
    expect(result).toContain("... cut; read a smaller line range to see more");
  });
});
