import { describe, expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import type { Message, Result } from "../src/core/errors.ts";
import type {
  ContextSource,
  SavedSession,
  SessionSource,
} from "../src/repl/session.ts";
import { Session } from "../src/repl/session.ts";

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

describe("Session /save and /resume (core)", () => {
  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };

  function makeSessionSource(
    sessions: Record<string, SavedSession>,
    autoCalls: { name: string; messages: Message[]; overwrite: boolean }[],
  ): SessionSource {
    const saved: Record<string, SavedSession> = { ...sessions };
    return {
      async save(
        name: string,
        messages: Message[],
        activeProfile: string | undefined,
        overwrite: boolean,
      ) {
        let finalName = name;
        let counter = 2;
        while (!overwrite && saved[finalName]) {
          finalName = `${name}-${counter}`;
          counter++;
        }
        saved[finalName] = {
          messages,
          activeProfile,
          savedAt: "t",
        };
        autoCalls.push({ name: finalName, messages: [...messages], overwrite });
        return { ok: true, value: finalName };
      },
      async saveNamed(
        name: string,
        messages: Message[],
        activeProfile: string | undefined,
      ) {
        let finalName = name;
        let counter = 2;
        while (saved[finalName]) {
          finalName = `${name}-${counter}`;
          counter++;
        }
        saved[finalName] = {
          messages,
          activeProfile,
          savedAt: "t",
        };
        return { ok: true, value: finalName };
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
      async delete(name: string): Promise<Result<void>> {
        if (!saved[name]) {
          return {
            ok: false,
            error: {
              kind: "malformed" as const,
              body: `session '${name}' not found`,
            },
          };
        }
        delete saved[name];
        return { ok: true, value: undefined };
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

  test("/save <name> reports a numeric suffix when the name is taken", async () => {
    const ss = makeSessionSource(
      { mywork: { messages: [], activeProfile: undefined, savedAt: "t" } },
      [],
    );
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/save mywork");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toContain("mywork-2");
  });

  test("/save with no args lists saved sessions", async () => {
    const ss = makeSessionSource(
      { previous: { messages: [], activeProfile: undefined, savedAt: "t" } },
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
    expect(result.value).toContain("previous");
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

  test("/resume keeps the live system message at index 0 (invariant #6)", async () => {
    // A saved snapshot from a *different* cwd carries its own system message.
    // After resume, the live system message must win so that subsequent turns
    // (and doCompact) observe the constructor-set system message.
    const seen: Message[][] = [];
    const captureClient: Client = {
      async chat(messages: Message[]) {
        seen.push([...messages]);
        return { ok: true, value: { content: "reply" } };
      },
    };
    const savedMessages: Message[] = [
      { role: "system", content: "Working directory: /saved" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const ss = makeSessionSource(
      {
        old: {
          messages: savedMessages,
          activeProfile: undefined,
          savedAt: "t",
        },
      },
      [],
    );
    const session = new Session(captureClient, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const resumed = await session.handleLine("/resume old");
    if (resumed === "exit" || !resumed.ok)
      throw new Error("expected ok resume");
    // A turn after resume sends the live conversation to the model.
    const turn = await session.handleLine("hi");
    if (turn === "exit" || !turn.ok) throw new Error("expected ok turn");
    expect(seen.length).toBe(1);
    const sent = seen[0];
    expect(sent?.[0]?.role).toBe("system");
    expect(sent?.[0]?.content).toBe("Working directory: /tmp");
  });

  test("auto-save after resume overwrites the resumed session", async () => {
    const autoCalls: { name: string; messages: Message[]; overwrite: boolean }[] = [];
    const savedMessages: Message[] = [
      { role: "system", content: "Working directory: /saved" },
      { role: "user", content: "earlier" },
      { role: "assistant", content: "earlier reply" },
    ];
    const ss = makeSessionSource(
      { old: { messages: savedMessages, activeProfile: undefined, savedAt: "t" } },
      autoCalls,
    );
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const resumed = await session.handleLine("/resume old");
    if (resumed === "exit" || !resumed.ok) throw new Error("expected resume");
    const turn = await session.handleLine("continue");
    if (turn === "exit" || !turn.ok) throw new Error("expected turn");
    expect(autoCalls[0]?.name).toBe("old");
    expect(autoCalls[0]?.overwrite).toBe(true);
  });

  test("/resume with no args lists saved sessions", async () => {
    const ss = makeSessionSource(
      { previous: { messages: [], activeProfile: undefined, savedAt: "t" } },
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
    expect(result.value).toContain("previous");
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
    const autoCalls: { name: string; messages: Message[]; overwrite: boolean }[] = [];
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
    expect(first?.name).toBe("hello");
    expect(first?.overwrite).toBe(false);
    expect(first?.messages.length).toBeGreaterThanOrEqual(3);
  });

  test("auto-save resolves a collision once and reuses the resolved name", async () => {
    const autoCalls: { name: string; messages: Message[]; overwrite: boolean }[] = [];
    const ss = makeSessionSource(
      { hello: { messages: [], activeProfile: undefined, savedAt: "t" } },
      autoCalls,
    );
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const firstTurn = await session.handleLine("hello");
    if (firstTurn === "exit" || !firstTurn.ok) throw new Error("expected first turn");
    const secondTurn = await session.handleLine("again");
    if (secondTurn === "exit" || !secondTurn.ok) throw new Error("expected second turn");
    expect(autoCalls.map((call) => call.name)).toEqual(["hello-2", "hello-2"]);
    expect(autoCalls.map((call) => call.overwrite)).toEqual([false, true]);
  });

  test("auto-save failure does not interrupt the turn", async () => {
    const failing: SessionSource = {
      async save() {
        return {
          ok: false,
          error: { kind: "network" as const, cause: "disk full" },
        };
      },
      async saveNamed(name: string) {
        return { ok: true, value: name };
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
      async delete(): Promise<Result<void>> {
        return {
          ok: false,
          error: { kind: "malformed" as const, body: "none" },
        };
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

  test("/delete <name> removes the session and reports success", async () => {
    const ss = makeSessionSource(
      {
        old: {
          messages: [{ role: "system", content: "s" }],
          activeProfile: undefined,
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
    const result = await session.handleLine("/delete old");
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    expect(result.value).toBe("deleted session 'old'");
  });

  test("/delete with no args returns a usage error", async () => {
    const ss = makeSessionSource({}, []);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/delete");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toContain("usage: /delete");
    }
  });

  test("/delete <name> returns an error when the session is not found", async () => {
    const ss = makeSessionSource({}, []);
    const session = new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
    const result = await session.handleLine("/delete nothere");
    if (result === "exit" || result.ok)
      throw new Error("expected error result");
    expect(result.error.kind).toBe("malformed");
    if (result.error.kind === "malformed") {
      expect(result.error.body).toContain("not found");
    }
  });
});
