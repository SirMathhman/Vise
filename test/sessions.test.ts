import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveAutoSession,
  saveNamedSession,
  loadSession,
  listSessions,
  AUTO_SAVE_NAME,
} from "../src/sessions.ts";
import type { Message } from "../src/core/errors.ts";

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vise-sessions-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("saveAutoSession (edge)", () => {
  test("writes a snapshot under the fixed auto name and creates the directory", () => {
    const base = mkdtempSync(join(tmpDir, "auto-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ];
    const result = saveAutoSession(base, messages, undefined);
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const p = join(base, "sessions", `${AUTO_SAVE_NAME}.json`);
      expect(existsSync(p)).toBeTrue();
      const loaded = loadSession(base, AUTO_SAVE_NAME);
      expect(loaded.ok).toBeTrue();
      if (loaded.ok) {
        expect(loaded.value.messages.length).toBe(3);
        expect(loaded.value.messages[0]?.role).toBe("system");
        expect(loaded.value.activeProfile).toBeUndefined();
      }
    }
  });

  test("saves the active profile when present", () => {
    const base = mkdtempSync(join(tmpDir, "auto-profile-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    const result = saveAutoSession(base, messages, "persona");
    expect(result.ok).toBeTrue();
    if (result.ok) {
      const loaded = loadSession(base, AUTO_SAVE_NAME);
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

  test("rejects the reserved auto name", () => {
    const base = mkdtempSync(join(tmpDir, "named-reserved-"));
    const messages: Message[] = [
      { role: "system", content: "Working directory: /tmp" },
    ];
    const result = saveNamedSession(base, AUTO_SAVE_NAME, messages, undefined);
    expect(result.ok).toBeFalse();
    if (!result.ok) {
      expect(result.error.kind).toBe("malformed");
      if (result.error.kind === "malformed") {
        expect(result.error.body).toContain("invalid session name");
      }
    }
    // No file must be written for a reserved name.
    expect(
      existsSync(join(base, "sessions", `${AUTO_SAVE_NAME}.json`)),
    ).toBeFalse();
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
    saveAutoSession(base, [{ role: "system", content: "s" }], undefined);
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
    expect(names).toEqual(["alpha", "auto", "zeta"]);
  });
});
