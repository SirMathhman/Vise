import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleProfileMessage } from "../../../src/web/api/profiles-api.ts";
import { setProfileTools } from "../../../src/stores/profiles.ts";

const fresh = (): string => mkdtempSync(join(tmpdir(), "vise-profiles-api-"));
const send = (base: string, msg: Record<string, unknown>) => handleProfileMessage(base, msg) ?? [];

describe("profile editor messages", () => {
  test("other messages are not the profile editor's", () => {
    expect(handleProfileMessage(fresh(), { type: "notes_list" })).toBeNull();
    expect(handleProfileMessage(fresh(), { type: "profile_tools" })).toBeNull();
  });

  test("create, read, list", () => {
    const base = fresh();
    expect(send(base, { type: "profiles_list" })).toEqual([{ type: "profiles", profiles: [] }]);
    const created = send(base, { type: "profile_save", name: "writer", body: "Write well." });
    expect(created[0]).toEqual({ type: "profile_result", ok: true, name: "writer" });
    expect(created[1]).toEqual({ type: "profiles", profiles: ["writer"] });
    expect(send(base, { type: "profile_get", name: "writer" })).toEqual([
      { type: "profile", name: "writer", body: "Write well.\n" },
    ]);
  });

  test("creating a name that exists is refused", () => {
    const base = fresh();
    send(base, { type: "profile_save", name: "a", body: "one" });
    const again = send(base, { type: "profile_save", name: "a", body: "two" });
    expect(again[0]).toMatchObject({ type: "profile_result", ok: false });
    expect(send(base, { type: "profile_get", name: "a" })[0]).toMatchObject({ body: "one\n" });
  });

  test("editing keeps the tool whitelist, and a new name renames the file", () => {
    const base = fresh();
    send(base, { type: "profile_save", name: "old", body: "first" });
    setProfileTools(base, "old", ["read_file"]);
    const saved = send(base, { type: "profile_save", name: "new", from: "old", body: "second" });
    expect(saved[0]).toEqual({ type: "profile_result", ok: true, name: "new", from: "old" });
    expect(saved[1]).toEqual({ type: "profiles", profiles: ["new"] });
    const text = readFileSync(join(base, "profiles", "new.md"), "utf8");
    expect(text).toContain("tools: read_file");
    expect(text).toContain("second");
  });

  test("delete removes it; deleting a missing one fails", () => {
    const base = fresh();
    send(base, { type: "profile_save", name: "gone", body: "x" });
    const deleted = send(base, { type: "profile_delete", name: "gone" });
    expect(deleted[0]).toEqual({ type: "profile_result", ok: true, deleted: true, name: "gone" });
    expect(deleted[1]).toEqual({ type: "profiles", profiles: [] });
    expect(send(base, { type: "profile_delete", name: "gone" })[0]).toMatchObject({ ok: false });
  });

  test("a profile needs a valid name", () => {
    expect(send(fresh(), { type: "profile_save", name: " ", body: "x" })[0]).toMatchObject({ ok: false });
    expect(send(fresh(), { type: "profile_save", name: "../escape", body: "x" })[0]).toMatchObject({ ok: false });
  });
});
