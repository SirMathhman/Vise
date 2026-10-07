import { describe, expect, test } from "bun:test";
import type { Client, Tool, ToolRunner } from "../src/core/engine.ts";
import type { Message, Result } from "../src/core/errors.ts";
import type {
  ContextSource,
  SavedSession,
  SessionEntry,
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

const ID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ID_B = "bbbbbbbb-0000-4000-8000-000000000002";

const notFound = (ref: string): Result<never> => ({
  ok: false,
  error: { kind: "malformed", body: `session '${ref}' not found` },
});

function saved(
  id: string,
  name: string,
  extra: Partial<SavedSession> = {},
): SavedSession {
  return {
    id,
    name,
    messages: [],
    activeProfile: undefined,
    savedAt: "t",
    ...extra,
  };
}

describe("Session /save and /resume (core)", () => {
  const client: Client = {
    async chat() {
      return { ok: true, value: { content: "reply" } };
    },
  };

  interface SaveCall {
    id: string | undefined;
    name: string;
    messages: Message[];
  }

  /** An in-memory SessionSource keyed by id, recording every save call. */
  function makeSessionSource(
    sessions: SavedSession[],
    calls: SaveCall[] = [],
  ): SessionSource {
    const store = new Map(sessions.map((s) => [s.id, s]));
    let next = 1;
    const resolve = (ref: string) =>
      [...store.keys()].find((id) => id.startsWith(ref));
    return {
      async save(id, name, messages, activeProfile) {
        const finalId = id ?? `generated-${next++}`;
        store.set(finalId, {
          id: finalId,
          name,
          messages,
          activeProfile,
          savedAt: "t",
        });
        calls.push({ id, name, messages: [...messages] });
        return { ok: true, value: finalId };
      },
      async load(ref): Promise<Result<SavedSession>> {
        const id = resolve(ref);
        const found = id === undefined ? undefined : store.get(id);
        return found ? { ok: true, value: found } : notFound(ref);
      },
      async list(): Promise<Result<SessionEntry[]>> {
        return {
          ok: true,
          value: [...store.values()].map(({ id, name }) => ({ id, name })),
        };
      },
      async delete(ref): Promise<Result<string>> {
        const id = resolve(ref);
        if (id === undefined) return notFound(ref);
        store.delete(id);
        return { ok: true, value: id };
      },
    };
  }

  function makeSession(ss: SessionSource | undefined) {
    return new Session(client, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: ss,
    });
  }

  async function ok(session: Session, line: string): Promise<string> {
    const result = await session.handleLine(line);
    if (result === "exit" || !result.ok) throw new Error("expected ok result");
    return result.value;
  }

  test("/save <name> names the conversation's session and reports its id", async () => {
    const calls: SaveCall[] = [];
    const session = makeSession(makeSessionSource([], calls));
    // A normal turn auto-saves; /save then renames that same session.
    await ok(session, "hello");
    const value = await ok(session, "/save mywork");
    expect(value).toBe("saved session 'mywork' (generated-1)");
    expect(calls.map((c) => [c.id, c.name])).toEqual([
      [undefined, "hello"],
      ["generated-1", "mywork"],
    ]);
  });

  test("/save <name> before any turn creates a new session", async () => {
    const calls: SaveCall[] = [];
    const session = makeSession(makeSessionSource([], calls));
    expect(await ok(session, "/save fresh")).toBe(
      "saved session 'fresh' (generated-1)",
    );
    expect(calls[0]?.id).toBeUndefined();
  });

  test("/save with no args lists sessions with names and ids", async () => {
    const session = makeSession(
      makeSessionSource([saved(ID_A, "alpha"), saved(ID_B, "beta")]),
    );
    const value = await ok(session, "/save");
    expect(value).toContain(`alpha  (${ID_A})`);
    expect(value).toContain(`beta  (${ID_B})`);
  });

  test("/resume <id> restores the saved conversation and active profile", async () => {
    const body: Message[] = [
      { role: "system", content: "old" },
      { role: "user", content: "hi" },
    ];
    const session = makeSession(
      makeSessionSource([
        saved(ID_A, "alpha", { messages: body, activeProfile: "plan" }),
      ]),
    );
    const value = await ok(session, `/resume ${ID_A}`);
    expect(value).toContain("resumed session 'alpha'");
    expect(session.getActiveProfile()).toBe("plan");
  });

  test("/resume accepts a unique id prefix", async () => {
    const session = makeSession(
      makeSessionSource([saved(ID_A, "alpha"), saved(ID_B, "beta")]),
    );
    expect(await ok(session, "/resume bbbb")).toContain(
      "resumed session 'beta'",
    );
  });

  test("/resume keeps the live system message at index 0 (invariant #6)", async () => {
    const seen: string[][] = [];
    const capturing: Client = {
      async chat(messages) {
        seen.push(messages.map((m) => m.content));
        return { ok: true, value: { content: "reply" } };
      },
    };
    const session = new Session(capturing, noopTools, noToolDefs, {
      cwd: "/tmp",
      context: noopContext,
      preTurnHooks: [],
      postTurnHooks: [],
      sessionSource: makeSessionSource([
        saved(ID_A, "alpha", {
          messages: [
            { role: "system", content: "saved system" },
            { role: "user", content: "earlier" },
          ],
        }),
      ]),
    });
    await ok(session, `/resume ${ID_A}`);
    await ok(session, "next");
    expect(seen[0]?.[0]).toBe("Working directory: /tmp");
    expect(seen[0]).toContain("earlier");
    expect(seen[0]).not.toContain("saved system");
  });

  test("auto-save after resume overwrites the resumed session", async () => {
    const calls: SaveCall[] = [];
    const session = makeSession(
      makeSessionSource([saved(ID_A, "alpha")], calls),
    );
    await ok(session, `/resume ${ID_A}`);
    await ok(session, "continue");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.id).toBe(ID_A);
    expect(calls[0]?.name).toBe("alpha");
  });

  test("/resume with no args lists saved sessions", async () => {
    const session = makeSession(makeSessionSource([saved(ID_A, "alpha")]));
    expect(await ok(session, "/resume")).toContain(`alpha  (${ID_A})`);
  });

  test("/resume <id> returns an error when the session is not found", async () => {
    const session = makeSession(makeSessionSource([]));
    const result = await session.handleLine("/resume cccc");
    if (result === "exit" || result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("malformed");
  });

  test("/save and /resume return an error when sessionSource is absent", async () => {
    const session = makeSession(undefined);
    for (const line of ["/save x", "/resume x", "/delete x"]) {
      const result = await session.handleLine(line);
      if (result === "exit" || result.ok) throw new Error("expected error");
      expect(result.error.kind).toBe("malformed");
    }
  });

  test("auto-save runs after a successful turn and saves a copy of messages", async () => {
    const calls: SaveCall[] = [];
    const session = makeSession(makeSessionSource([], calls));
    await ok(session, "first message");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("first message");
    expect(calls[0]?.messages.some((m) => m.content === "first message")).toBe(
      true,
    );
  });

  test("auto-save reuses the id it was given on the first save", async () => {
    const calls: SaveCall[] = [];
    const session = makeSession(makeSessionSource([], calls));
    await ok(session, "one");
    await ok(session, "two");
    expect(calls.map((c) => c.id)).toEqual([undefined, "generated-1"]);
    expect(calls.map((c) => c.name)).toEqual(["one", "one"]);
  });

  test("auto-save failure does not interrupt the turn", async () => {
    const failing: SessionSource = {
      ...makeSessionSource([]),
      async save() {
        throw new Error("disk full");
      },
    };
    const session = makeSession(failing);
    expect(await ok(session, "hello")).toBe("reply");
  });

  test("/delete <id> removes the session and reports success", async () => {
    const session = makeSession(makeSessionSource([saved(ID_A, "alpha")]));
    expect(await ok(session, `/delete ${ID_A}`)).toBe(
      `deleted session ${ID_A}`,
    );
    expect(await ok(session, "/resume")).toBe("no saved sessions");
  });

  test("deleting the current session detaches it so auto-save starts a new one", async () => {
    const calls: SaveCall[] = [];
    const session = makeSession(makeSessionSource([], calls));
    await ok(session, "hello");
    await ok(session, "/delete generated-1");
    await ok(session, "again");
    expect(calls.map((c) => c.id)).toEqual([undefined, undefined]);
  });

  test("/delete with no args returns a usage error", async () => {
    const session = makeSession(makeSessionSource([]));
    const result = await session.handleLine("/delete");
    if (result === "exit" || result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("malformed");
  });

  test("/delete <id> returns an error when the session is not found", async () => {
    const session = makeSession(makeSessionSource([]));
    const result = await session.handleLine("/delete cccc");
    if (result === "exit" || result.ok) throw new Error("expected error");
    expect(result.error.kind).toBe("malformed");
  });
});
