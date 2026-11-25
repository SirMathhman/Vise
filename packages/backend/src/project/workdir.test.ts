import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./workdir";

describe("PROJECT_ROOT", () => {
  test("is the repository root, not a folder inside it", () => {
    expect(existsSync(path.join(PROJECT_ROOT, "packages", "backend"))).toBe(
      true,
    );
    expect(existsSync(path.join(PROJECT_ROOT, ".git"))).toBe(true);
  });
});
