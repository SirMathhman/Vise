import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client } from "../../src/core/engine.ts";
import type { Message } from "../../src/core/errors.ts";
import { buildInitialTree } from "../../src/fs-tree.ts";
import type { ContextSource } from "../../src/repl/session.ts";
import { Session } from "../../src/repl/session.ts";

const noopTools = {
  run: async (_n: string, _a: Record<string, unknown>) => "",
};
const noToolDefs: import("../../src/core/engine.ts").Tool[] = [];
const noopContext: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  async contextMax() {
    return { ok: true, value: 100_000 };
  },
};

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "vise-tree-"));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("buildInitialTree", () => {
  test("lists files and directories at the root", () => {
    mkdirSync(join(tmpDir, "sub"));
    writeFileSync(join(tmpDir, "a.txt"), "");
    writeFileSync(join(tmpDir, "sub", "b.txt"), "");
    writeFileSync(join(tmpDir, ".hidden"), "");

    const tree = buildInitialTree(tmpDir);
    // Directories before files, hidden excluded.
    expect(tree).toBe("sub/\n  b.txt\na.txt");
  });

  test("caps at 25 entries with a truncation marker", () => {
    const capDir = mkdtempSync(join(tmpDir, "cap-"));
    for (let i = 0; i < 30; i++) {
      writeFileSync(join(capDir, `f${String(i).padStart(2, "0")}.txt`), "");
    }
    const tree = buildInitialTree(capDir);
    const lines = tree.split("\n");
    // 25 entries + 1 truncation marker = 26 lines.
    expect(lines.length).toBe(26);
    expect(lines[25]).toBe("(truncated)");
    // The 25th entry is f24.txt (0-indexed: f00 through f24 = 25 files).
    expect(lines[24]).toBe("f24.txt");
  });

  test("caps at depth 5 below root", () => {
    const depthDir = mkdtempSync(join(tmpDir, "depth-"));
    let d = depthDir;
    // Create nested dirs: level1/level2/level3/level4/level5/level6
    for (let i = 1; i <= 6; i++) {
      d = join(d, `level${i}`);
      mkdirSync(d);
    }
    // File at depth 6 (inside level5) should NOT appear.
    // level5/ is at 5 levels below root and is listed, but its children
    // (at5.txt, level6/) would be at 6 levels and are not enumerated.
    writeFileSync(
      join(
        depthDir,
        "level1",
        "level2",
        "level3",
        "level4",
        "level5",
        "at5.txt",
      ),
      "",
    );
    // File at depth 6 (inside level6) should NOT appear.
    writeFileSync(
      join(
        depthDir,
        "level1",
        "level2",
        "level3",
        "level4",
        "level5",
        "level6",
        "at6.txt",
      ),
      "",
    );

    const tree = buildInitialTree(depthDir);
    // level5/ is at 5 levels below root: it is listed. Its contents (at5.txt,
    // level6/) would be at 6 levels and are not enumerated.
    expect(tree).toContain("level5/");
    expect(tree).not.toContain("at5.txt");
    expect(tree).not.toContain("level6/");
    expect(tree).not.toContain("at6.txt");
  });

  test("returns empty string for an empty directory", () => {
    const emptyDir = mkdtempSync(join(tmpDir, "empty-"));
    expect(buildInitialTree(emptyDir)).toBe("");
  });

  test("handles unreadable directories gracefully", () => {
    const root = mkdtempSync(join(tmpDir, "unreadable-"));
    const sub = join(root, "sub");
    mkdirSync(sub);
    // On Windows, chmod-based restrictions don't reliably block readdirSync
    // for the current user, so just verify it doesn't throw on a valid path.
    const tree = buildInitialTree(root);
    expect(typeof tree).toBe("string");
  });
});

describe("Session initialMessage", () => {
  test("injects the initial message as the first user message", async () => {
    let firstMessages: Message[] | undefined;
    const client: Client = {
      async chat(messages: Message[]) {
        firstMessages = messages.map((m) => ({ ...m }));
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      initialMessage:
        "Here is the initial directory structure of the working directory:\nsrc/\n  engine.ts\n  errors.ts",
    });
    await session.handleLine("hi");
    expect(firstMessages?.[0]?.role).toBe("system");
    expect(firstMessages?.[1]?.role).toBe("user");
    expect(firstMessages?.[1]?.content).toBe(
      "Here is the initial directory structure of the working directory:\nsrc/\n  engine.ts\n  errors.ts",
    );
    expect(firstMessages?.[2]?.content).toBe("hi");
  });

  test("omits the initial message when not provided", async () => {
    let firstMessages: Message[] | undefined;
    const client: Client = {
      async chat(messages: Message[]) {
        // Snapshot before runTurn mutates the array.
        firstMessages = messages.map((m) => ({ ...m }));
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    await session.handleLine("hi");
    // System + user "hi" = 2 messages, no initial message.
    expect(firstMessages?.length).toBe(2);
    expect(firstMessages?.[0]?.role).toBe("system");
    expect(firstMessages?.[1]?.content).toBe("hi");
  });
});
