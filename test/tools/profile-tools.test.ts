import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Client, Tool, ToolRunner } from "@vise/core";
import {
  parseProfile,
  readProfile,
  readProfileTools,
  setProfileTools,
} from "../../src/stores/profiles.ts";
import { ToolSet } from "../../src/tools.ts";
import type { ContextSource } from "../../src/repl/session.ts";
import { Session } from "../../src/repl/session.ts";

describe("profile frontmatter (edge)", () => {
  test("parses the tools whitelist and strips it from the body", () => {
    const p = parseProfile("---\ntools: a, b\n---\nBody text\n");
    expect(p.tools).toEqual(["a", "b"]);
    expect(p.body).toBe("Body text\n");
    expect(parseProfile("No frontmatter").tools).toBeUndefined();
  });

  test("setProfileTools writes and clears the whitelist, keeping the body", () => {
    const base = mkdtempSync(join(tmpdir(), "vise-prof-"));
    mkdirSync(join(base, "profiles"));
    const file = join(base, "profiles", "p.md");
    writeFileSync(file, "Be careful.\n");
    setProfileTools(base, "p", ["read_file"]);
    expect(readProfileTools(base, "p")).toEqual(["read_file"]);
    expect(readProfile(base, "p")).toBe("Be careful.\n");
    setProfileTools(base, "p", undefined);
    expect(readFileSync(file, "utf8")).toBe("Be careful.\n");
  });
});

describe("Session profile tool whitelist (core)", () => {
  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };
  const runner: ToolRunner = { run: async () => "out" };
  const def = (name: string): Tool => ({
    type: "function",
    function: { name, description: "", parameters: {} },
  });
  const context: ContextSource = {
    lastPromptTokensUsed: () => undefined,
    async contextMax() {
      return { ok: true, value: 100_000 };
    },
  };

  function make() {
    const whitelists: Record<string, string[] | undefined> = {
      strict: ["read_file"],
    };
    const controller = new ToolSet([def("read_file"), def("delete_file")]);
    const profileSource = {
      listProfiles: async () => ({
        ok: true as const,
        value: ["strict", "open"],
      }),
      loadProfile: async () => ({ ok: true as const, value: "body" }),
      initProfile: async (n: string) => ({ ok: true as const, value: n }),
      profileTools: async (n: string) => ({
        ok: true as const,
        value: whitelists[n],
      }),
      setProfileTools: async (n: string, tools: string[] | undefined) => {
        whitelists[n] = tools;
        return { ok: true as const, value: n };
      },
    };
    const session = new Session(client, runner, [], {
      cwd: "/tmp",
      context,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource,
      toolController: controller,
    });
    return { session, controller, whitelists };
  }

  test("entering a whitelisted profile enables only its tools, leaving restores", async () => {
    const { session, controller } = make();
    controller.set("delete_file", false);
    await session.handleLine("/profile strict");
    expect(controller.list()).toEqual([
      { name: "read_file", enabled: true },
      { name: "delete_file", enabled: false },
    ]);
    controller.set("read_file", false);
    await session.handleLine("/profile open");
    // Restored to the states from before the whitelist was applied.
    expect(controller.list()).toEqual([
      { name: "read_file", enabled: true },
      { name: "delete_file", enabled: false },
    ]);
  });

  test("/profile <name> tools shows, sets (validating names) and clears", async () => {
    const { session, whitelists } = make();
    const run = async (line: string) => {
      const r = await session.handleLine(line);
      if (r === "exit") throw new Error("exit");
      return r;
    };
    expect(await run("/profile open tools read_file,delete_file")).toEqual({
      ok: true,
      value: "profile 'open' tools: read_file, delete_file",
    });
    expect(whitelists.open).toEqual(["read_file", "delete_file"]);
    const bad = await run("/profile open tools nope");
    expect(bad.ok).toBe(false);
    expect(await run("/profile open tools all")).toEqual({
      ok: true,
      value: "profile 'open' tools: all",
    });
    expect(whitelists.open).toBeUndefined();
  });
  test("editing the active profile's whitelist leaves live tool state alone", async () => {
    const { session, controller, whitelists } = make();
    await session.handleLine("/profile strict");
    const before = controller.list();
    await session.handleLine("/profile strict tools read_file,delete_file");
    expect(whitelists.strict).toEqual(["read_file", "delete_file"]);
    expect(controller.list()).toEqual(before);
  });
});

describe("tool enablement is per session (edge)", () => {
  test("one session's tool state does not leak into another", async () => {
    const { createEdgeSession } = await import("../../src/wiring.ts");
    const options = {
      askUser: { ask: async () => "" },
      onMaxRounds: async () => false,
    };
    const a = createEdgeSession(options);
    const b = createEdgeSession(options);
    a.toolController.set("read_file", false);
    expect(a.toolController.isEnabled("read_file")).toBe(false);
    expect(b.toolController.isEnabled("read_file")).toBe(true);
  });
});

describe("lazy /profile (core)", () => {
  test("only the last /profile before a turn reaches the conversation", async () => {
    let seen: string[] = [];
    const client: Client = {
      async chat(messages) {
        seen = messages.map((m) => m.content);
        return { ok: true, value: { content: "reply" } };
      },
    };
    const profileSource = {
      listProfiles: async () => ({ ok: true as const, value: ["a", "b", "c"] }),
      loadProfile: async (n: string) => ({
        ok: true as const,
        value: `body of ${n}`,
      }),
      initProfile: async (n: string) => ({ ok: true as const, value: n }),
    };
    const session = new Session(client, { run: async () => "out" }, [], {
      cwd: "/tmp",
      context: {
        lastPromptTokensUsed: () => undefined,
        async contextMax() {
          return { ok: true, value: 100_000 };
        },
      },
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource,
    });
    for (const p of ["a", "b", "c"]) await session.handleLine(`/profile ${p}`);
    expect(session.getActiveProfile()).toBe("c");
    await session.handleLine("hello");
    expect(seen.filter((c) => c.startsWith("body of "))).toEqual(["body of c"]);
    expect(seen.indexOf("body of c")).toBeLessThan(seen.indexOf("hello"));
  });
});

describe("/new (core)", () => {
  test("starts a fresh conversation but re-applies the active profile", async () => {
    let seen: string[] = [];
    const client: Client = {
      async chat(messages) {
        seen = messages.map((m) => m.content);
        return { ok: true, value: { content: "reply" } };
      },
    };
    const profileSource = {
      listProfiles: async () => ({ ok: true as const, value: ["a"] }),
      loadProfile: async () => ({ ok: true as const, value: "body of a" }),
      initProfile: async (n: string) => ({ ok: true as const, value: n }),
    };
    const session = new Session(client, { run: async () => "out" }, [], {
      cwd: "/tmp",
      context: {
        lastPromptTokensUsed: () => undefined,
        async contextMax() {
          return { ok: true, value: 100_000 };
        },
      },
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource,
      initialMessage: "project map",
    });
    await session.handleLine("/profile a");
    await session.handleLine("first conversation");
    expect(await session.handleLine("/new")).toEqual({
      ok: true,
      value: "started a new conversation",
    });
    await session.handleLine("second conversation");
    expect(seen).toEqual([
      "Working directory: /tmp",
      "project map",
      "body of a",
      "second conversation",
    ]);
    expect(session.getActiveProfile()).toBe("a");
  });
});
