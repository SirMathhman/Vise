import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTool } from "../../src/tools";

// Registry calls pass the project root first. Tools that read only their arguments must still get them.
describe("tool dispatch", () => {
  beforeEach(() => {
    process.env.VISE_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), "vise-dispatch-"),
    );
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("a note tool and check_command receive the arguments the model sent", async () => {
    const context = { root: "/project" };
    expect(
      await runTool(context, "read_note", JSON.stringify({ id: "missing" })),
    ).toBe("No note has that id.");
    expect(
      await runTool(context, "check_command", JSON.stringify({ id: "nope" })),
    ).toBe("No background command has that id.");
  });
});
