import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/core/errors.ts";
import { closeAllDbs } from "../../src/db/open.ts";
import {
  deleteSession,
  latestSessionId,
  listSessions,
  loadSession,
  saveSession,
  searchSessions,
} from "../../src/stores/sessions.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vise-sessions-"));
});

afterAll(() => {
  closeAllDbs();
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

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function idOf(result: { ok: boolean; value?: string }): string {
  if (!result.ok || result.value === undefined) throw new Error("save failed");
  return result.value;
}

describe("saveSession (edge)", () => {
  test("creates the database and keys the session by a generated uuid", () => {
    const base = freshBase();
    const id = idOf(
      saveSession(base, undefined, "My work", messages, undefined),
    );
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(base, "vise.db"))).toBe(true);
    expect(existsSync(join(base, "sessions"))).toBe(false);
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
    const loaded = loadSession(base, id);
    expect(loaded.ok && loaded.value.name).toBe("weird: name/with *chars*");
  });

  test("an id overwrites that session and can rename it", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "first", messages, undefined));
    const again = idOf(saveSession(base, id, "renamed", messages, undefined));
    expect(again).toBe(id);
    expect(listSessions(base)).toEqual(ok([{ id, name: "renamed" }]));
  });

  test("two sessions may share a display name", () => {
    const base = freshBase();
    const a = idOf(saveSession(base, undefined, "same", messages, undefined));
    const b = idOf(saveSession(base, undefined, "same", messages, undefined));
    expect(a).not.toBe(b);
    const listed = listSessions(base);
    expect(listed.ok && listed.value).toHaveLength(2);
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
    for (const id of ["abc00000-0000", "abc11111-0000"]) {
      saveSession(base, id, id, messages, undefined);
    }
    const result = loadSession(base, "abc");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === "malformed") {
      expect(result.error.body).toContain("ambiguous");
    }
  });
});

describe("listSessions (edge)", () => {
  test("returns an empty array when the directory does not exist", () => {
    expect(listSessions(join(freshBase(), "nope"))).toEqual(ok([]));
  });

  test("lists id and name, sorted by name", () => {
    const base = freshBase();
    const b = idOf(saveSession(base, undefined, "beta", messages, undefined));
    const a = idOf(saveSession(base, undefined, "alpha", messages, undefined));
    expect(listSessions(base)).toEqual(
      ok([
        { id: a, name: "alpha" },
        { id: b, name: "beta" },
      ]),
    );
  });

  test("latestSessionId is the most recently saved", async () => {
    const base = freshBase();
    const first = idOf(saveSession(base, undefined, "a", messages, undefined));
    await Bun.sleep(5);
    const second = idOf(saveSession(base, undefined, "b", messages, undefined));
    expect(latestSessionId(base)).toEqual(ok(second));
    await Bun.sleep(5);
    saveSession(base, first, "a", messages, undefined);
    expect(latestSessionId(base)).toEqual(ok(first));
  });
});

describe("round trip", () => {
  test("keeps tool calls, tool ids, images and typed marks", () => {
    const base = freshBase();
    const full: Message[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi", typed: true },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          {
            type: "function",
            id: "c1",
            function: { name: "read_file", arguments: '{"path":"a"}' },
          },
        ],
      },
      {
        role: "tool",
        content: "ok",
        tool_call_id: "c1",
        images: [{ id: "ab", mime: "image/png", label: "x", bytes: 3 }],
      },
    ];
    const id = idOf(saveSession(base, undefined, "rt", full, undefined));
    const loaded = loadSession(base, id);
    expect(loaded.ok && loaded.value.messages).toEqual(full);
  });
});

describe("legacy JSON import", () => {
  function legacy(base: string, file: string, body: string): string {
    mkdirSync(join(base, "sessions"), { recursive: true });
    const path = join(base, "sessions", file);
    writeFileSync(path, body);
    return path;
  }

  test("imports a valid file once and deletes it", () => {
    const base = freshBase();
    const path = legacy(
      base,
      "abc123.json",
      JSON.stringify({
        name: "old",
        messages,
        activeProfile: "plan",
        savedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    const loaded = loadSession(base, "abc123");
    expect(loaded.ok && loaded.value.messages).toEqual(messages);
    expect(loaded.ok && loaded.value.activeProfile).toBe("plan");
    expect(loaded.ok && loaded.value.savedAt).toBe("2020-01-01T00:00:00.000Z");
    expect(existsSync(path)).toBe(false);
  });

  test("keeps a file that is not valid", () => {
    const base = freshBase();
    const bad = legacy(base, "bad0.json", "{ not json");
    const noMessages = legacy(base, "bad1.json", JSON.stringify({ x: 1 }));
    expect(listSessions(base)).toEqual(ok([]));
    expect(existsSync(bad)).toBe(true);
    expect(existsSync(noMessages)).toBe(true);
  });
});

describe("storage failures", () => {
  test("a corrupt column is returned as a storage error, not thrown", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "x", messages, undefined));
    const db = new Database(join(base, "vise.db"));
    db.query("UPDATE messages SET images = '{bad' WHERE seq = 1").run();
    db.close();
    closeAllDbs();
    const loaded = loadSession(base, id);
    expect(!loaded.ok && loaded.error.kind).toBe("storage");
  });

  test("an unopenable database is returned as a storage error", () => {
    const base = freshBase();
    mkdirSync(join(base, "vise.db"));
    const saved = saveSession(base, undefined, "x", messages, undefined);
    expect(!saved.ok && saved.error.kind).toBe("storage");
  });
});

describe("searchSessions (edge)", () => {
  test("finds the sessions whose messages mention a phrase", () => {
    const base = freshBase();
    const hit = idOf(
      saveSession(
        base,
        undefined,
        "fruit",
        [{ role: "user", content: "I like green apples" }],
        undefined,
      ),
    );
    saveSession(base, undefined, "other", messages, undefined);
    const found = searchSessions(base, "green apples");
    expect(found.ok && found.value.map((h) => h.id)).toEqual([hit]);
    expect(found.ok && found.value[0]?.snippet).toContain("[green apples]");
  });

  test("a deleted session no longer matches", () => {
    const base = freshBase();
    const id = idOf(
      saveSession(
        base,
        undefined,
        "gone",
        [{ role: "user", content: "zebra" }],
        undefined,
      ),
    );
    deleteSession(base, id);
    const found = searchSessions(base, "zebra");
    expect(found.ok && found.value).toEqual([]);
  });
});

describe("deleteSession (edge)", () => {
  test("removes a session by id or prefix and returns the full id", () => {
    const base = freshBase();
    const id = idOf(saveSession(base, undefined, "gone", messages, undefined));
    const deleted = deleteSession(base, id.slice(0, 8));
    expect(deleted.ok && deleted.value).toBe(id);
    expect(listSessions(base)).toEqual(ok([]));
  });

  test("returns an error when the session is not found", () => {
    const result = deleteSession(freshBase(), "abcdef");
    expect(result.ok).toBe(false);
  });
});
