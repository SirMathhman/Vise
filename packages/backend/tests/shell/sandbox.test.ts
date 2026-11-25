import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SANDBOX_IMAGE, sandboxArguments } from "../../src/shell/sandbox";

describe("sandboxArguments", () => {
  test("mounts only the project, drops privileges, and bounds the command with timeout", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vise-sandbox-"));
    const args = sandboxArguments(root, "vise-command-x", "echo hi", 30);
    expect(args.slice(0, 5)).toEqual([
      "podman",
      "run",
      "--rm",
      "--name",
      "vise-command-x",
    ]);
    expect(args).toContain("--cap-drop=all");
    expect(args).toContain(`${root}:/workspace`);
    const image = args.indexOf(SANDBOX_IMAGE);
    expect(args.slice(image + 1)).toEqual([
      "timeout",
      "--kill-after=2",
      "30",
      "bash",
      "-c",
      "echo hi",
    ]);
    expect(args.some((arg) => arg.endsWith(".env:ro"))).toBe(false);
  });

  test("hides the backend .env file behind an empty read-only file when it exists", () => {
    const root = mkdtempSync(path.join(tmpdir(), "vise-sandbox-"));
    mkdirSync(path.join(root, "packages/backend"), { recursive: true });
    writeFileSync(
      path.join(root, "packages/backend/.env"),
      "OPENROUTER_API_KEY=x",
    );
    const args = sandboxArguments(root, "vise-command-x", "true", 30);
    expect(args).toContain("/dev/null:/workspace/packages/backend/.env:ro");
  });
});
