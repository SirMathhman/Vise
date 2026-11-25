import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNote } from "../../src/notes/notes-store";
import { enabledToolDefinitions } from "../../src/tools";
import {
  saveProfileToolList,
  saveToolSettings,
} from "../../src/tools/tool-settings";
import { handleProfileToolSettings } from "../../src/tools/tools-routes";

const names = (
  result: Awaited<ReturnType<typeof enabledToolDefinitions>>,
): string[] =>
  result.ok ? result.value.map((tool) => tool.function.name) : [];

describe("profile tool whitelists", () => {
  beforeEach(() => {
    process.env.VISE_CONFIG_DIR = mkdtempSync(
      path.join(tmpdir(), "vise-profile-tools-"),
    );
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("a whitelist offers exactly its tools, even one turned off; no whitelist follows the switches", async () => {
    await saveToolSettings({ disabled: ["run_command"] });
    await saveProfileToolList("p1", ["run_command", "read_file"]);
    expect(names(await enabledToolDefinitions("p1"))).toEqual([
      "read_file",
      "run_command",
    ]);
    expect(names(await enabledToolDefinitions("p2"))).not.toContain(
      "run_command",
    );
    expect(names(await enabledToolDefinitions())).not.toContain("run_command");
  });

  test("only a profile note can have a whitelist", async () => {
    const note = await createNote({
      name: "Plain",
      category: "todo",
      summary: "",
      content: "x",
    });
    if (!note.ok) {
      throw new Error("setup failed");
    }
    const refused = await handleProfileToolSettings(
      new Request(
        `http://127.0.0.1:3000/api/tool-settings/profiles/${note.value.id}`,
        {
          method: "PUT",
          body: JSON.stringify({ tools: ["read_file"] }),
        },
      ),
      `/api/tool-settings/profiles/${note.value.id}`,
    );
    expect(refused.status).toBe(400);
  });
});
