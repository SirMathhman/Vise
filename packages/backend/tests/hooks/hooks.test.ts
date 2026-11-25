import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHook } from "../../src/hooks/hooks";

describe("hooks", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vise-hooks-"));
    process.env.VISE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("an event with no command, or no hooks file, succeeds without running anything", async () => {
    expect(await runHook("beforeTurn", dir)).toEqual({
      ok: true,
      value: undefined,
    });
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({ afterTurn: "exit 0" }),
    );
    expect(await runHook("beforeSession", dir)).toEqual({
      ok: true,
      value: undefined,
    });
  });

  test("a command that exits with 0 succeeds, and one that fails reports its exit code", async () => {
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({ afterTurn: "exit 0", beforeTurn: "exit 3" }),
    );
    expect(await runHook("afterTurn", dir)).toEqual({
      ok: true,
      value: undefined,
    });
    const failed = await runHook("beforeTurn", dir);
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error).toStartWith(
        "The beforeTurn hook exited with code 3.",
      );
    }
  });
});

describe("hook limits and environment", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vise-hooks-"));
    process.env.VISE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
    delete process.env.VISE_TEST_API_KEY;
  });

  test("a hook that runs past its time limit is stopped, and the error names the hook", async () => {
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({ beforeTurn: 'bun -e "setTimeout(() => {}, 5000)"' }),
    );
    const stopped = await runHook("beforeTurn", dir, 300);
    expect(stopped.ok).toBe(false);
    if (!stopped.ok) {
      expect(stopped.error).toStartWith("The beforeTurn hook failed:");
    }
  });

  test("a hook does not receive variables whose names look like credentials", async () => {
    process.env.VISE_TEST_API_KEY = "secret-value";
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({
        beforeTurn:
          'bun -e "process.exit(process.env.VISE_TEST_API_KEY ? 1 : 0)"',
      }),
    );
    expect(await runHook("beforeTurn", dir)).toEqual({
      ok: true,
      value: undefined,
    });
  });
});
