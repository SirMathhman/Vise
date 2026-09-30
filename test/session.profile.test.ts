import { describe, test, expect } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import type { Message } from "../src/core/errors.ts";
import { Session } from "../src/repl/session.ts";
import type { ContextSource } from "../src/repl/session.ts";

const noopTools: ToolRunner = {
  async run(_name, _args) {
    return "tool output";
  },
};

const noToolDefs: Tool[] = [];

/** A ContextSource that reports no usage and a large window, so auto-compact
 * is a no-op (the Session test only exercises the turn path). */
const noopContext: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  async contextMax() {
    return { ok: true, value: 100_000 };
  },
};

describe("Session /profile init command (core)", () => {
  /**
   * A ProfileSource stub that records initProfile calls and reports a
   * fixed set of existing profile names, so tests can exercise the
   * /profile init dispatch without touching the filesystem.
   */
  function makeProfileSource(existing: string[] = []) {
    const inits: string[] = [];
    return {
      inits,
      listProfiles: async () => ({ ok: true as const, value: existing }),
      loadProfile: async (name: string) => ({
        ok: true as const,
        value: existing.includes(name) ? "profile body" : "",
      }),
      initProfile: async (name: string) => {
        inits.push(name);
        if (existing.includes(name)) {
          return {
            ok: false as const,
            error: {
              kind: "malformed" as const,
              body: `profile '${name}' already exists`,
            },
          };
        }
        return { ok: true as const, value: name };
      },
    };
  }

  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };

  test("/profile init <name> calls initProfile and reports success", async () => {
    const ps = makeProfileSource();
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: ps,
    });
    const result = await session.handleLine("/profile init mypersona");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("initialized profile 'mypersona'");
    expect(ps.inits).toEqual(["mypersona"]);
  });

  test("/profile init without a name returns a usage error", async () => {
    const ps = makeProfileSource();
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: ps,
    });
    const result = await session.handleLine("/profile init");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toBe("usage: /profile init <name>");
    }
    expect(ps.inits).toEqual([]);
  });

  test("/profile init surfaces a failure when the profile already exists", async () => {
    const ps = makeProfileSource(["dup"]);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: ps,
    });
    const result = await session.handleLine("/profile init dup");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toBe("profile 'dup' already exists");
    }
  });

  test("/profile when profileSource is absent returns an error", async () => {
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    const result = await session.handleLine("/profile init x");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toBe(
        "profiles not supported by the current client",
      );
    }
  });
});

describe("Session /profile default (core)", () => {
  /**
   * A capturing ProfileSource: it records which profile names are loaded so
   * tests can prove that `default` is resolved by the session (not via the
   * source), while any other name still goes through to the filesystem-backed
   * source as before.
   */
  function makeCapturingSource(existing: string[] = []) {
    const loaded: string[] = [];
    return {
      loaded,
      listProfiles: async () => ({ ok: true as const, value: existing }),
      loadProfile: async (name: string) => {
        loaded.push(name);
        return { ok: true as const, value: "profile body" };
      },
      initProfile: async (name: string) => ({ ok: true as const, value: name }),
    };
  }

  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };

  test("/profile default sets the built-in default without loading a file", async () => {
    const seen: Message[][] = [];
    const captureClient: Client = {
      async chat(messages: Message[]) {
        seen.push([...messages]);
        return { ok: true, value: { content: "reply" } };
      },
    };
    const ps = makeCapturingSource(["mypersona"]);
    const session = new Session(captureClient, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: ps,
    });
    const result = await session.handleLine("/profile default");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("profile set to default");
    // `default` must not be resolved through the ProfileSource: no load call.
    expect(ps.loaded).toEqual([]);
    // The baseline text is injected as a user message, system message intact
    // at index 0 (invariant #6).
    await session.handleLine("hi");
    const last = seen[seen.length - 1];
    if (last === undefined) throw new Error("expected a captured turn");
    const first = last[0];
    if (first === undefined) throw new Error("expected a system message");
    expect(first.role).toBe("system");
    expect(last.some((m) => m.content.includes("helpful assistant"))).toBe(
      true,
    );
  });

  test("/profile default is listed first even when no profile files exist", async () => {
    const ps = makeCapturingSource([]);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: ps,
    });
    const result = await session.handleLine("/profile");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    // The built-in default is surfaced first, before any file-backed entries.
    // A single-entry list has no trailing newline, so check the first line.
    expect(result.value.split("\n")[0]).toBe("  default");
  });

  test("/profile <name> still routes a real profile through the source", async () => {
    const ps = makeCapturingSource(["mypersona"]);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      profileSource: ps,
    });
    const result = await session.handleLine("/profile mypersona");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("profile set to mypersona");
    // A non-default name is resolved through the ProfileSource as before.
    expect(ps.loaded).toEqual(["mypersona"]);
  });
});
