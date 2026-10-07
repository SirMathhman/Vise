import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../src/core/errors.ts";
import {
  deleteSession,
  listSessions,
  loadSession,
  saveSession,
} from "../src/sessions.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vise-sessions-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** A fresh base directory per test, so tests cannot see each other's files. */
function freshBase(): string {
  return mkdtempSync(join(tmpDir, "case-"));
}

const messages: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
];

function idOf(result: { ok: boolean; value?: string }): string {
  if (!result.ok || result.value === undefined) throw new Error("save failed");
  return result.value;
}

describe("saveSession (edge)", () => {
  test("creates the directory and names the file by a generated uuid", () => {
    const base = freshBase();
    const id = idOf(
      saveSession(base, undefined, "My work", messages, undefined),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readdirSync(join(base, "sessions"))).toEqual([`${id}.json`]);
  });

  test("keeps the display name out of the file name, whatever it contains", () => {
    const base = freshBase();
    const id = idOf(
      saveSession(
        base,
        undefined,
        "weird: name/with *chars* ",
        messages,
        undefined,
      ),
    );
    expect(existsSync(join(base, "sessions", `${id}.json`))).toBe(true);
    const loaded = loadSession(base, id);
    expect(loaded.ok && loaded.value.name).toBe("weird: name/with *chars*");
  });

  test("an id overwrites that session and can rename it", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "first", messages, undefined));
    const again = idOf(saveSession(base, id, "renamed", messages, undefined));
    expect(again).toBe(id);
    expect(listSessions(base)).toEqual([{ id, name: "renamed" }]);
  });

  test("two sessions may share a display name", () => {
    const base = freshBase();
    const a = idOf(saveSession(base, undefined, "same", messages, undefined));
    const b = idOf(saveSession(base, undefined, "same", messages, undefined));
    expect(a).not.toBe(b);
    expect(listSessions(base)).toHaveLength(2);
  });

  test("rejects a blank name", () => {
    const result = saveSession(
      freshBase(),
      undefined,
      "   ",
      messages,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  test("rejects an id that is not path-safe", () => {
    const result = saveSession(
      freshBase(),
      "../evil",
      "x",
      messages,
      undefined,
    );
    expect(result.ok).toBe(false);
  });

  test("saves the active profile when present", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "p", messages, "plan"));
    const loaded = loadSession(base, id);
    expect(loaded.ok && loaded.value.activeProfile).toBe("plan");
  });
});

describe("loadSession (edge)", () => {
  test("loads by full id and by unique prefix", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "n", messages, undefined));
    const full = loadSession(base, id);
    const prefix = loadSession(base, id.slice(0, 8));
    expect(full.ok && full.value.messages).toEqual(messages);
    expect(prefix.ok && prefix.value.id).toBe(id);
  });

  test("returns an error when the session is not found", () => {
    const result = loadSession(freshBase(), "abcdef");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("not found");
    }
  });

  test("returns an error for a reference that is not an id", () => {
    const result = loadSession(freshBase(), "My work");
    expect(result.ok).toBe(false);
  });

  test("returns an error when a prefix matches several sessions", () => {
    const base = freshBase();
    mkdirSync(join(base, "sessions"));
    for (const id of ["abc00000-0000", "abc11111-0000"]) {
      writeFileSync(
        join(base, "sessions", `${id}.json`),
        JSON.stringify({ name: id, messages: [], savedAt: "" }),
      );
    }
    const result = loadSession(base, "abc");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("ambiguous");
    }
  });

  test("returns an error when the file is not valid JSON", () => {
    const base = freshBase();
    mkdirSync(join(base, "sessions"));
    writeFileSync(join(base, "sessions", "bad0.json"), "{ not json");
    const result = loadSession(base, "bad0");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("invalid JSON");
    }
  });

  test("returns an error when the shape is missing messages", () => {
    const base = freshBase();
    mkdirSync(join(base, "sessions"));
    writeFileSync(
      join(base, "sessions", "bad1.json"),
      JSON.stringify({ x: 1 }),
    );
    expect(loadSession(base, "bad1").ok).toBe(false);
  });
});

describe("listSessions (edge)", () => {
  test("returns an empty array when the directory does not exist", () => {
    expect(listSessions(join(freshBase(), "nope"))).toEqual([]);
  });

  test("lists id and name, sorted by name, excluding non-json files", () => {
    const base = freshBase();
    const b = idOf(saveSession(base, undefined, "beta", messages, undefined));
    const a = idOf(saveSession(base, undefined, "alpha", messages, undefined));
    writeFileSync(join(base, "sessions", "notes.txt"), "ignore me");
    expect(listSessions(base)).toEqual([
      { id: a, name: "alpha" },
      { id: b, name: "beta" },
    ]);
  });

  test("lists an unreadable file under its id so it can still be deleted", () => {
    const base = freshBase();
    mkdirSync(join(base, "sessions"));
    writeFileSync(join(base, "sessions", "dead.json"), "garbage");
    expect(listSessions(base)).toEqual([{ id: "dead", name: "dead" }]);
  });
});

describe("deleteSession (edge)", () => {
  test("removes a session by id or prefix and returns the full id", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "gone", messages, undefined));
    const deleted = deleteSession(base, id.slice(0, 8));
    expect(deleted.ok && deleted.value).toBe(id);
    expect(existsSync(join(base, "sessions", `${id}.json`))).toBe(false);
  });

  test("returns an error when the session is not found", () => {
    const result = deleteSession(freshBase(), "abcdef");
    expect(result.ok).toBe(false);
  });
});
