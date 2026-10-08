import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySettings, config } from "../src/config.ts";
import { loadSettingsFile, saveSettings } from "../src/settings-file.ts";

const file = (): string => join(mkdtempSync(join(tmpdir(), "vise-env-")), ".env");

afterEach(() => applySettings({}));

test("a saved setting is live at once and kept in the file", () => {
  const path = file();
  expect(saveSettings({ VISE_SAVE_EVERY_ROUNDS: "7" }, path)).toBeUndefined();
  expect(config.saveEvery).toBe(7);
  expect(readFileSync(path, "utf8")).toContain("VISE_SAVE_EVERY_ROUNDS=7");
});

test("an empty value goes back to the default", () => {
  const path = file();
  saveSettings({ VISE_SAVE_EVERY_ROUNDS: "7" }, path);
  saveSettings({ VISE_SAVE_EVERY_ROUNDS: "" }, path);
  expect(config.saveEvery).toBe(25);
  expect(readFileSync(path, "utf8")).not.toContain("VISE_SAVE_EVERY_ROUNDS");
});

test("a bad number or unknown name is refused and nothing changes", () => {
  const path = file();
  expect(saveSettings({ VISE_SAVE_EVERY_ROUNDS: "lots" }, path)).toContain("number");
  expect(saveSettings({ NOPE: "1" }, path)).toContain("unknown");
  expect(config.saveEvery).toBe(25);
});

test("a blank secret keeps the saved one; a bad file value falls back to the default", () => {
  const path = file();
  saveSettings({ VISE_LLM_API_KEY: "abc" }, path);
  saveSettings({ VISE_LLM_API_KEY: "" }, path);
  expect(config.llmApiKey).toBe("abc");
  writeFileSync(path, "VISE_SAVE_EVERY_ROUNDS=banana\nOTHER=keep\n");
  loadSettingsFile(path);
  expect(config.saveEvery).toBe(25);
  saveSettings({ VISE_SHELL_TIMEOUT_MS: "1000" }, path);
  expect(readFileSync(path, "utf8")).toContain("OTHER=keep");
});

test("a secret can be cleared explicitly, and quotes in a hand-written file are dropped", () => {
  const path = file();
  writeFileSync(path, 'VISE_LLM_API_KEY="abc"\n');
  loadSettingsFile(path);
  expect(config.llmApiKey).toBe("abc");
  expect(saveSettings({}, path, ["VISE_LLM_API_KEY"])).toBeUndefined();
  expect(config.llmApiKey).toBe("");
});
