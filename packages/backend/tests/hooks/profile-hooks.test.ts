import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createNote } from "../../src/notes/notes-store";
import { handleHooks } from "../../src/hooks/hooks-routes";
import { runHook } from "../../src/hooks/hooks";

const BASE = "http://localhost:3000";

describe("profile hooks", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "vise-profile-hooks-"));
    process.env.VISE_CONFIG_DIR = dir;
  });

  afterEach(() => {
    delete process.env.VISE_CONFIG_DIR;
  });

  test("a profile's command runs after the global one, and a failing global command stops it", async () => {
    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({ beforeTurn: "exit 0" }),
    );
    writeFileSync(
      path.join(dir, "profile-hooks.json"),
      JSON.stringify({ p1: { beforeTurn: "exit 3" } }),
    );
    const profileFails = await runHook("beforeTurn", dir, undefined, "p1");
    expect(profileFails.ok).toBe(false);
    if (!profileFails.ok) {
      expect(profileFails.error).toStartWith(
        "The beforeTurn hook exited with code 3.",
      );
    }

    writeFileSync(
      path.join(dir, "hooks.json"),
      JSON.stringify({ beforeTurn: "exit 4" }),
    );
    const globalFails = await runHook("beforeTurn", dir, undefined, "p1");
    expect(globalFails.ok).toBe(false);
    if (!globalFails.ok) {
      expect(globalFails.error).toStartWith(
        "The beforeTurn hook exited with code 4.",
      );
    }
  });

  test("only a profile note can hold profile commands, and saved commands are read back", async () => {
    const profile = await createNote({
      name: "Terse",
      category: "profile",
      summary: "",
      content: "Be brief.",
    });
    const note = await createNote({
      name: "Shopping",
      category: "todo",
      summary: "",
      content: "Milk",
    });
    if (!profile.ok || !note.ok) {
      throw new Error("setup failed");
    }
    const put = (id: string) =>
      handleHooks(
        new Request(`${BASE}/api/hooks/profiles/${id}`, {
          method: "PUT",
          body: JSON.stringify({ afterTurn: "exit 0" }),
        }),
        `/api/hooks/profiles/${id}`,
      );
    expect((await put(note.value.id)).status).toBe(400);
    expect((await put(profile.value.id)).status).toBe(200);

    const read = await handleHooks(
      new Request(`${BASE}/api/hooks`),
      "/api/hooks",
    );
    expect(await read.json()).toEqual({
      global: {},
      profiles: { [profile.value.id]: { afterTurn: "exit 0" } },
    });
  });
});
