import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enabledToolDefinitions } from "../../src/tools";
import {
  readToolSettings,
  saveToolSettings,
} from "../../src/tools/tool-settings";
import { handleToolSettings } from "../../src/tools/tools-routes";

describe("tool settings", () => {
  beforeEach(() => {
    process.env.VISE_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), "vise-tool-settings-"),
    );
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("a saved list turns those tools off, and an unknown name is refused", async () => {
    expect(await readToolSettings()).toEqual({
      ok: true,
      value: { disabled: [] },
    });
    await saveToolSettings({ disabled: ["run_command"] });
    expect(await readToolSettings()).toEqual({
      ok: true,
      value: { disabled: ["run_command"] },
    });

    const enabled = await enabledToolDefinitions();
    expect(
      enabled.ok && enabled.value.map((t) => t.function.name),
    ).not.toContain("run_command");

    const refused = await handleToolSettings(
      new Request("http://127.0.0.1:3000/api/tool-settings", {
        method: "PUT",
        body: JSON.stringify({ disabled: ["no_such_tool"] }),
      }),
    );
    expect(refused.status).toBe(400);
  });
});
