import { describe, test, expect } from "bun:test";
import type {
  Client,
  Tool,
  ToolRunner,
  ToolController,
} from "../src/core/engine.ts";
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
