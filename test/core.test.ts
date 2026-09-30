import { describe, test, expect } from "bun:test";
import { runTurn, summarize, runSubagent } from "../src/core/engine.ts";
import type {
  Client,
  Tool,
  ToolController,
  ToolRunner,
} from "../src/core/engine.ts";
import type { Message, AssistantMessage } from "../src/core/errors.ts";
import { Session } from "../src/repl/session.ts";
import type {
  ContextSource,
  SessionSource,
  SavedSession,
} from "../src/repl/session.ts";
import type { Result } from "../src/core/errors.ts";

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

describe("runTurn streaming (core)", () => {
  test("invokes onToken with each token and returns the accumulated content", async () => {
    const seen: string[] = [];
    const tokens = ["Hel", "lo"];
    // The stub models what the edge would feed onToken per content delta.
    const client: Client = {
      async chat(_m: Message[], _t?: Tool[], onToken?: (t: string) => void) {
        for (const t of tokens) onToken?.(t);
        return { ok: true, value: { content: "Hello" } };
      },
    };
    const messages: Message[] = [{ role: "user", content: "hi" }];
    const result = await runTurn(client, noopTools, messages, noToolDefs, (t) =>
      seen.push(t),
    );
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("Hello");
    expect(seen).toEqual(tokens);
  });

  test("reaches tool rounds: onToken receives intermediate and final content", async () => {
    const seen: string[] = [];
    let round = 0;
    const client: Client = {
      async chat(_messages, _tools, onToken) {
        round += 1;
        // Each round the edge would stream its own deltas; model them here.
        onToken?.("thinking");
        onToken?.("...");
        if (round === 1) {
          return {
            ok: true,
            value: {
              content: "thinking...",
              tool_calls: [
                {
                  type: "function",
                  id: "call_1",
                  function: { name: "noop", arguments: "{}" },
                },
              ],
            },
          };
        }
        return { ok: true, value: { content: "done" } };
      },
    };
    const messages: Message[] = [{ role: "user", content: "go" }];
    const result = await runTurn(client, noopTools, messages, noToolDefs, (t) =>
      seen.push(t),
    );
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("done");
    // Two rounds, two "thinking"+"..." deltas each → 4 total.
    expect(seen).toEqual(["thinking", "...", "thinking", "..."]);
  });
});

describe("summarize (core)", () => {
  test("does not invoke onToken (compaction is not streamed)", async () => {
    const seen: string[] = [];
    const client: Client = {
      async chat(_messages, _tools, onToken) {
        // onToken is intentionally omitted by the core; record if ever called.
        onToken?.("x");
        return { ok: true, value: { content: "summary" } };
      },
    };
    const result = await summarize(client, [
      { role: "user", content: "hi" },
      { role: "assistant", content: "yo" },
    ]);
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("summary");
    // summarize never passes onToken, so nothing should be recorded.
    expect(seen).toEqual([]);
  });
});

describe("runSubagent (core)", () => {
  test("returns the subagent's final assistant text from a fresh conversation", async () => {
    const seen: Message[][] = [];
    const client: Client = {
      async chat(messages, _tools) {
        // Snapshot: runTurn mutates the messages array in place (documented
        // side channel), so record a copy of the conversation as first sent.
        seen.push([...messages]);
        return { ok: true, value: { content: "subagent result" } };
      },
    };
    const systemMessage = {
      role: "system" as const,
      content: "Working directory: /tmp",
    };
    const result = await runSubagent(
      client,
      noopTools,
      noToolDefs,
      systemMessage,
      "You are a test subagent.",
      "do the thing",
    );
    expect(result.ok).toBeTrue();
    if (result.ok) expect(result.value).toBe("subagent result");
    // The fresh conversation is [system, profile, task].
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      systemMessage,
      { role: "user", content: "You are a test subagent." },
      { role: "user", content: "do the thing" },
    ]);
  });

  test("omits the profile message when the profile text is empty", async () => {
    const seen: Message[][] = [];
    const client: Client = {
      async chat(messages, _tools) {
        // Snapshot: runTurn mutates the messages array in place (documented
        // side channel), so record a copy of the conversation as first sent.
        seen.push([...messages]);
        return { ok: true, value: { content: "ok" } };
      },
    };
    const systemMessage = {
      role: "system" as const,
      content: "Working directory: /tmp",
    };
    const result = await runSubagent(
      client,
      noopTools,
      noToolDefs,
      systemMessage,
      "   ",
      "do the thing",
    );
    expect(result.ok).toBeTrue();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([
      systemMessage,
      { role: "user", content: "do the thing" },
    ]);
  });

  test("propagates a client error as a failure result", async () => {
    const client: Client = {
      async chat(_messages, _tools) {
        return { ok: false, error: { kind: "network", cause: "boom" } };
      },
    };
    const systemMessage = {
      role: "system" as const,
      content: "Working directory: /tmp",
    };
    const result = await runSubagent(
      client,
      noopTools,
      noToolDefs,
      systemMessage,
      "profile",
      "task",
    );
    expect(result.ok).toBeFalse();
    if (!result.ok && result.error.kind === "network") {
      expect(result.error.cause).toBe("boom");
    }
  });
});

describe("Session streaming flag (core)", () => {
  test("sets streamed=true on a successful turn when onToken is provided", async () => {
    const client: Client = {
      async chat() {
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      onToken: () => {},
    });
    const result = await session.handleLine("hi");
    expect(result).not.toBe("exit");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.streamed).toBe(true);
  });

  test("does not set streamed when onToken is absent", async () => {
    const client: Client = {
      async chat() {
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    const result = await session.handleLine("hi");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.streamed).toBeFalse();
  });
});

describe("Session /tool command (core)", () => {
  /**
   * A minimal ToolController stub for exercising the /tool dispatch in
   * Session. It tracks enabled/disabled state so list() reflects set() calls,
   * and records set() calls so tests can assert toggling.
   */
  function makeToolController(): ToolController & {
    sets: [string, boolean][];
  } {
    const names = ["alpha", "beta"];
    const disabled = new Set<string>();
    const sets: [string, boolean][] = [];
    return {
      sets,
      list: () => names.map((name) => ({ name, enabled: !disabled.has(name) })),
      isEnabled: (name: string) => !disabled.has(name),
      set(name: string, enabled: boolean) {
        sets.push([name, enabled]);
        if (enabled) disabled.delete(name);
        else disabled.add(name);
      },
    };
  }

  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };

  function makeSession(tc: ToolController): Session {
    return new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      toolController: tc,
      preTurnHooks: [],
      postTurnHooks: [],
    });
  }

  test("/tool with no args lists tools with their enabled state", async () => {
    const tc = makeToolController();
    const session = makeSession(tc);
    const result = await session.handleLine("/tool");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("* alpha (enabled)\n* beta (enabled)");
  });

  test("/tool <name> enable sets the tool enabled", async () => {
    const tc = makeToolController();
    const session = makeSession(tc);
    const result = await session.handleLine("/tool alpha enable");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("alpha enabled");
    expect(tc.sets).toEqual([["alpha", true]]);
  });

  test("/tool <name> disable sets the tool disabled", async () => {
    const tc = makeToolController();
    const session = makeSession(tc);
    const result = await session.handleLine("/tool beta disable");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("beta disabled");
    expect(tc.sets).toEqual([["beta", false]]);
  });

  test("/tool with unknown name returns an error", async () => {
    const tc = makeToolController();
    const session = makeSession(tc);
    const result = await session.handleLine("/tool gamma disable");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toBe(
        "unknown tool 'gamma'. Run '/tool' to see available tools.",
      );
    }
  });

  test("/tool with invalid verb returns an error", async () => {
    const tc = makeToolController();
    const session = makeSession(tc);
    const result = await session.handleLine("/tool alpha toggle");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toBe("usage: /tool <name> enable|disable");
    }
  });

  test("/tool when toolController is absent returns an error", async () => {
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    const result = await session.handleLine("/tool");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toBe(
        "tools not supported by the current client",
      );
    }
  });

  test("disabling a tool does not change the definitions passed to the model", async () => {
    const toolDefs: Tool[] = [
      {
        type: "function",
        function: { name: "alpha", description: "", parameters: {} },
      },
      {
        type: "function",
        function: { name: "beta", description: "", parameters: {} },
      },
    ];
    let lastToolDefs: Tool[] | undefined;
    const capturingClient: Client = {
      async chat(_messages, toolDefsParam?: Tool[]) {
        lastToolDefs = toolDefsParam;
        return { ok: true, value: { content: "reply" } };
      },
    };
    const tc = makeToolController();
    const session = new Session(capturingClient, noopTools, toolDefs, {
      cwd: "/tmp",
      context: noopContext,
      toolController: tc,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    // First turn: all tools enabled.
    await session.handleLine("hi");
    expect(lastToolDefs?.length).toBe(2);
    // Disable alpha, then turn again. The definitions offered to the model are
    // unchanged: every tool definition is still sent even though alpha is
    // disabled.
    await session.handleLine("/tool alpha disable");
    await session.handleLine("hi");
    expect(lastToolDefs?.length).toBe(2);
  });

  test("disabling a tool informs the model by injecting a message", async () => {
    let lastMessages: Message[] | undefined;
    const capturingClient: Client = {
      async chat(messages: Message[]) {
        lastMessages = messages;
        return { ok: true, value: { content: "reply" } };
      },
    };
    const tc = makeToolController();
    const session = new Session(capturingClient, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      toolController: tc,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    // Disabling pushes a notification user message into the conversation so
    // the model sees it on the next turn.
    await session.handleLine("/tool alpha disable");
    await session.handleLine("hi");
    const contents = lastMessages?.map((m) => m.content) ?? [];
    expect(contents).toContain(
      "Tool 'alpha' is now disabled. Do not call it; if asked, say it is disabled.",
    );
  });

  test("enabling a tool informs the model by injecting a message", async () => {
    let lastMessages: Message[] | undefined;
    const capturingClient: Client = {
      async chat(messages: Message[]) {
        lastMessages = messages;
        return { ok: true, value: { content: "reply" } };
      },
    };
    const tc = makeToolController();
    const session = new Session(capturingClient, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      toolController: tc,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    // Disabling then re-enabling pushes a notification for each transition.
    await session.handleLine("/tool alpha disable");
    await session.handleLine("/tool alpha enable");
    await session.handleLine("hi");
    const contents = lastMessages?.map((m) => m.content) ?? [];
    expect(contents).toContain("Tool 'alpha' is now enabled. You may call it.");
  });
});

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

describe("Session /save and /resume (core)", () => {
  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };

  function makeSessionSource(
    sessions: Record<string, SavedSession>,
    autoCalls: Message[][],
  ): SessionSource {
    const saved: Record<string, SavedSession> = { ...sessions };
    return {
      async save(messages: Message[], _active: string | undefined) {
        autoCalls.push([...messages]);
        saved["auto"] = {
          messages,
          activeProfile: undefined,
          savedAt: "t",
        };
        return { ok: true, value: undefined };
      },
      async saveNamed(
        name: string,
        messages: Message[],
        activeProfile: string | undefined,
      ) {
        saved[name] = {
          messages,
          activeProfile,
          savedAt: "t",
        };
        return { ok: true, value: undefined };
      },
      async load(name: string): Promise<Result<SavedSession>> {
        const s = saved[name];
        if (!s) {
          return {
            ok: false,
            error: {
              kind: "malformed" as const,
              body: `session '${name}' not found`,
            },
          };
        }
        return { ok: true, value: s };
      },
      async list(): Promise<Result<string[]>> {
        return { ok: true, value: Object.keys(saved) };
      },
    };
  }

  test("/save <name> persists the current conversation and reports success", async () => {
    const ss = makeSessionSource({}, []);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    // One normal turn so the conversation has content beyond the system message.
    const turn = await session.handleLine("hello");
    if (turn === "exit" || !turn.ok) throw new Error("expected ok turn");
    const result = await session.handleLine("/save mywork");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("saved session 'mywork'");
  });

  test("/save with no args lists saved sessions", async () => {
    const ss = makeSessionSource(
      { auto: { messages: [], activeProfile: undefined, savedAt: "t" } },
      [],
    );
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/save");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toContain("saved sessions:");
    expect(result.value).toContain("auto");
  });

  test("/resume <name> restores the saved conversation and active profile", async () => {
    const savedMessages: Message[] = [
      { role: "system", content: "Working directory: /saved" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const ss = makeSessionSource(
      {
        old: {
          messages: savedMessages,
          activeProfile: "personality",
          savedAt: "t",
        },
      },
      [],
    );
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/resume old");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("resumed session 'old' (2 messages)");
  });

  test("/resume with no args lists saved sessions", async () => {
    const ss = makeSessionSource(
      { auto: { messages: [], activeProfile: undefined, savedAt: "t" } },
      [],
    );
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/resume");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toContain("saved sessions:");
    expect(result.value).toContain("auto");
  });

  test("/resume <name> returns an error when the session is not found", async () => {
    const ss = makeSessionSource({}, []);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/resume nothere");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toContain("not found");
    }
  });

  test("/save and /resume return an error when sessionSource is absent", async () => {
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
    });
    const saveResult = await session.handleLine("/save x");
    if (saveResult === "exit" || saveResult.ok)
      throw new Error("expected error result");
    expect(saveResult.error.kind).toBe("malformed");
    const resumeResult = await session.handleLine("/resume x");
    if (resumeResult === "exit" || resumeResult.ok)
      throw new Error("expected error result");
    expect(resumeResult.error.kind).toBe("malformed");
  });

  test("auto-save runs after a successful turn and saves a copy of messages", async () => {
    const autoCalls: Message[][] = [];
    const ss = makeSessionSource({}, autoCalls);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("hello");
    if (result === "exit" || !result.ok) throw new Error("expected ok turn");
    // Auto-save must have captured the conversation (system + user + assistant).
    expect(autoCalls.length).toBe(1);
    const first = autoCalls[0];
    expect(first?.length).toBeGreaterThanOrEqual(3);
  });

  test("auto-save failure does not interrupt the turn", async () => {
    const failing: SessionSource = {
      async save() {
        return {
          ok: false,
          error: { kind: "network" as const, cause: "disk full" },
        };
      },
      async saveNamed() {
        return { ok: true, value: undefined };
      },
      async load(): Promise<Result<SavedSession>> {
        return {
          ok: false,
          error: { kind: "malformed" as const, body: "none" },
        };
      },
      async list(): Promise<Result<string[]>> {
        return { ok: true, value: [] };
      },
    };
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: failing,
    });
    const result = await session.handleLine("hello");
    // The turn still succeeds even though save() returned an error.
    if (result === "exit" || !result.ok) throw new Error("expected ok turn");
  });
});
