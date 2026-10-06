import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
  saveAutoSession,
  saveNamedSession,
} from "../src/sessions.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vise-sessions-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveAutoSession (edge)", () => {
  test("writes a snapshot under the given name and creates the directory", () => {
    const base = mkdtempSync(join(tmpDir, "auto-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const result = saveAutoSession(base, "hello", messages, undefined, false);
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const p = join(base, "sessions", "hello.json");
      expect(existsSync(p)).toBeTrue();
      const loaded = loadSession(base, "hello");
      expect(loaded.ok).toBeTrue();
      if (loaded.ok) {
        expect(loaded.value.messages.length).toBe(3);
        expect(loaded.value.messages[0]?.role).toBe("system");
        expect(loaded.value.activeProfile).toBeUndefined();
      }
    }
  });

  test("first autosave resolves collisions and later autosave overwrites", () => {
    const base = mkdtempSync(join(tmpDir, "auto-overwrite-"));
    const first: Message[] = [{ role: "system", content: "s" }];
    const second: Message[] = [
      { role: "system", content: "s" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const result1 = saveAutoSession(base, "hello", first, undefined, false);
    expect(result1).toEqual({ ok: true, value: "hello" });
    const collision = saveAutoSession(base, "hello", first, undefined, false);
    expect(collision).toEqual({ ok: true, value: "hello-2" });
    const result2 = saveAutoSession(base, "hello-2", second, undefined, true);
    expect(result2).toEqual({ ok: true, value: "hello-2" });
    const loaded = loadSession(base, "hello-2");
    expect(loaded.ok).toBeTrue();
    if (loaded.ok) {
      expect(loaded.value.messages.length).toBe(3);
    }
  });

  test("saves the active profile when present", () => {
    const base = mkdtempSync(join(tmpDir, "auto-profile-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    const result = saveAutoSession(base, "hello", messages, "persona", false);
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const loaded = loadSession(base, "hello");
      expect(loaded.ok).toBeTrue();
      if (loaded.ok) {
        expect(loaded.value.activeProfile).toBe("persona");
      }
    }
  });
});

describe("saveNamedSession (edge)", () => {
  test("writes a named snapshot", () => {
    const base = mkdtempSync(join(tmpDir, "named-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
      { role: "user", content: "hi" },
    ];
    const result = saveNamedSession(base, "mywork", messages, "persona");
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const p = join(base, "sessions", "mywork.json");
      expect(existsSync(p)).toBeTrue();
      const loaded = loadSession(base, "mywork");
      expect(loaded.ok).toBeTrue();
      if (loaded.ok) {
        expect(loaded.value.activeProfile).toBe("persona");
      }
    }
  });

  test("appends a numeric suffix when the requested name already exists", () => {
    const base = mkdtempSync(join(tmpDir, "named-collision-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    const first = saveNamedSession(base, "mywork", messages, undefined);
    const second = saveNamedSession(base, "mywork", messages, undefined);
    expect(first).toEqual({ ok: true, value: "mywork" });
    expect(second).toEqual({ ok: true, value: "mywork-2" });
  });

  test("rejects names with path separators", () => {
    const base = mkdtempSync(join(tmpDir, "named-slash-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    const result = saveNamedSession(base, "a/b", messages, undefined);
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
    }
    const result2 = saveNamedSession(base, "a\\b", messages, undefined);
    expect(result2.ok).toBeFalse();
    if (!result2.ok) {
      expect(result2.error.kind).toBe("malformed");
    }
  });

  test("rejects dot-only names (path traversal)", () => {
    const base = mkdtempSync(join(tmpDir, "named-dots-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    const result = saveNamedSession(base, "..", messages, undefined);
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
    }
  });
});

describe("loadSession (edge)", () => {
  test("returns an error when the session is not found", () => {
    const base = mkdtempSync(join(tmpDir, "load-missing-"));
    const result = loadSession(base, "nope");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      if (result.error.kind === "malformed") {
        expect(result.error.body).toContain("not found");
      }
    }
  });

  test("returns an error when the file is not valid JSON", () => {
    const base = mkdtempSync(join(tmpDir, "load-badjson-"));
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(join(base, "sessions", "bad.json"), "not json{", "utf-8");
    const result = loadSession(base, "bad");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      if (result.error.kind === "malformed") {
        expect(result.error.body).toContain("invalid JSON");
      }
    }
  });

  test("returns an error when the shape is missing messages", () => {
    const base = mkdtempSync(join(tmpDir, "load-shape-"));
    mkdirSync(join(base, "sessions"), { recursive: true });
    writeFileSync(
      join(base, "sessions", "shape.json"),
      JSON.stringify({ activeProfile: "x", savedAt: "t" }),
      "utf-8",
    );
    const result = loadSession(base, "shape");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      if (result.error.kind === "malformed") {
        expect(result.error.body).toContain("corrupted");
      }
    }
  });

  test("loads a session with no active profile without a false corruption error", () => {
    const base = mkdtempSync(join(tmpDir, "load-noprofile-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
      { role: "user", content: "hi" },
    ];
    const saved = saveNamedSession(base, "noprofile", messages, undefined);
    expect(saved.ok).toBeTrue();
    const result = loadSession(base, "noprofile");
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value.activeProfile).toBeUndefined();
      expect(result.value.messages.length).toBe(2);
    }
  });

  test("loads a session with an active profile intact", () => {
    const base = mkdtempSync(join(tmpDir, "load-profile-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    saveNamedSession(base, "withprofile", messages, "persona");
    const result = loadSession(base, "withprofile");
    expect(result.ok).toBeTrue();
    if (result.ok) {
      expect(result.value.activeProfile).toBe("persona");
    }
  });
});

describe("listSessions (edge)", () => {
  test("returns an empty array when the directory does not exist", () => {
    const base = mkdtempSync(join(tmpDir, "list-none-"));
    expect(listSessions(base)).toEqual([]);
  });

  test("lists .json files by name, sorted, excluding non-json files", () => {
    const base = mkdtempSync(join(tmpDir, "list-some-"));
    saveAutoSession(
      base,
      "hello",
      [{ role: "system", content: "s" }],
      undefined,
      false,
    );
    saveNamedSession(
      base,
      "zeta",
      [{ role: "system", content: "s" }],
      undefined,
    );
    saveNamedSession(
      base,
      "alpha",
      [{ role: "system", content: "s" }],
      undefined,
    );
    // A non-json file must not appear in the list.
    writeFileSync(join(base, "sessions", "notes.txt"), "x", "utf-8");
    const names = listSessions(base);
    expect(names).toEqual(["alpha", "hello", "zeta"]);
  });
});

describe("deleteSession (edge)", () => {
  test("removes an existing named session", () => {
    const base = mkdtempSync(join(tmpDir, "del-exist-"));
    saveNamedSession(
      base,
      "temp",
      [{ role: "system", content: "s" }],
      undefined,
    );
    expect(existsSync(join(base, "sessions", "temp.json"))).toBeTrue();
    const result = deleteSession(base, "temp");
    expect(result.ok).toBeTrue();
    expect(existsSync(join(base, "sessions", "temp.json"))).toBeFalse();
  });

  test("returns an error when the session is not found", () => {
    const base = mkdtempSync(join(tmpDir, "del-missing-"));
    const result = deleteSession(base, "nope");
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      if (result.error.kind === "malformed") {
        expect(result.error.body).toContain("not found");
      }
    }
  });

  test("deletes an auto-saved session like any other session", () => {
    const base = mkdtempSync(join(tmpDir, "del-auto-named-"));
    saveAutoSession(
      base,
      "hello",
      [{ role: "system", content: "s" }],
      undefined,
      false,
    );
    const result = deleteSession(base, "hello");
    expect(result.ok).toBeTrue();
    expect(existsSync(join(base, "sessions", "hello.json"))).toBeFalse();
  });
});
