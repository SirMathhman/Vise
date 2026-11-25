import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  clearSavedOpenRouterKey,
  getSavedOpenRouterKey,
  saveOpenRouterKey,
} from "../src/settings";
import { PROJECT_ROOT } from "../src/project/workdir";

describe("saved OpenRouter key", () => {
  test("is stored outside the project, in the config folder, and can be cleared", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vise-config-"));
    process.env.VISE_CONFIG_DIR = dir;
    try {
      await saveOpenRouterKey("sk-test-123");
      expect(await getSavedOpenRouterKey()).toBe("sk-test-123");
      expect(existsSync(path.join(dir, "openrouter.env"))).toBe(true);
      expect(path.relative(PROJECT_ROOT, dir).startsWith("..")).toBe(true);
      await clearSavedOpenRouterKey();
      expect(await getSavedOpenRouterKey()).toBeUndefined();
    } finally {
      delete process.env.VISE_CONFIG_DIR;
    }
  });
});
