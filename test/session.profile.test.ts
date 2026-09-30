import { describe, test, expect } from "bun:test";
import type {
  Client,
  Tool,
  ToolRunner,
} from "../src/core/engine.ts";
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
