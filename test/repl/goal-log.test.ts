import { describe, expect, test } from "bun:test";
import type { Client, ToolRunner } from "@vise/core";
import type { Message, Result } from "@vise/core";
import type { GoalTraceEntry } from "@vise/core";
import type {
  ContextSource,
  SavedSession,
  SessionSource,
} from "../../packages/backend/src/repl/session.ts";
import { Session } from "../../packages/backend/src/repl/session.ts";

const tools: ToolRunner = { run: async () => "tool output" };
const context: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  async contextMax() {
    return { ok: true, value: 100_000 };
  },
};

/** A model that answers the goal questions with "met" and everything else with a plain reply. */
const client = (opts: { throws?: boolean } = {}): Client => ({
  chat: async (messages: Message[]) => {
    const question = messages[messages.length - 1]?.content ?? "";
    if (question.startsWith("[goal tracking")) {
      return { ok: true, value: { content: '{"goal":"say hi","done_when":"hi is said"}' } };
    }
    if (question.startsWith("[goal check")) {
      return { ok: true, value: { content: '{"verdict":"yes","detail":"it said hi"}' } };
    }
    if (opts.throws) throw new Error("the model fell over");
    return { ok: true, value: { content: "hi there" } };
  },
});

interface Saves {
  trace: GoalTraceEntry[] | undefined;
}

/** An in-memory SessionSource that keeps the last save's trace and can hand out a saved session. */
function source(saves: Saves[], existing?: SavedSession): SessionSource {
  return {
    async save(id, _name, _messages, _profile, _todos, goalTrace) {
      saves.push({ trace: goalTrace });
      return { ok: true, value: id ?? "generated-1" };
    },
    async load(): Promise<Result<SavedSession>> {
      return existing
        ? { ok: true, value: existing }
        : { ok: false, error: { kind: "malformed", body: "not found" } };
    },
    async list() {
      return { ok: true, value: [] };
    },
    async delete(ref) {
      return { ok: true, value: ref };
    },
  };
}

function makeSession(c: Client, ss: SessionSource): Session {
  return new Session(c, tools, [], {
    cwd: "/tmp",
    context,
    preTurnHooks: [],
    postTurnHooks: [],
    sessionSource: ss,
    goalChecking: true,
  });
}

async function text(session: Session, line: string): Promise<string> {
  const result = await session.handleLine(line);
  if (result === "exit" || !result.ok) throw new Error("expected an ok result");
  return result.value;
}

const kinds = (entries: GoalTraceEntry[] | undefined): string[] =>
  (entries ?? []).map((e) => e.kind);

describe("the goal trace of a conversation", () => {
  test("/goal log shows the hidden questions and why the turn ended", async () => {
    const session = makeSession(client(), source([]));
    await text(session, "say hi");
    const log = await text(session, "/goal log");
    expect(log).toContain("turn 1");
    expect(log).toContain("ask goal-check");
    expect(log).toContain("[goal check, not from the user] Goal: say hi");
    expect(log).toContain("EXIT met: it said hi");
    expect(log).toContain("model's last reply: hi there");
  });

  test("the trace is saved with the session", async () => {
    const saves: Saves[] = [];
    const session = makeSession(client(), source(saves));
    await text(session, "say hi");
    const last = saves.at(-1)?.trace;
    expect(kinds(last)).toEqual(["turn_start", "ask", "goal", "ask", "verdict", "exit"]);
  });

  test("a resumed conversation gets its trace back and keeps adding to it", async () => {
    const earlier: GoalTraceEntry[] = [
      {
        kind: "exit",
        reason: "blocked",
        detail: "needs a login",
        lastReply: "",
        toolResults: 0,
        at: "2026-10-09T01:00:00.000Z",
        after: 3,
      },
    ];
    const saved: SavedSession = {
      id: "aaaaaaaa-0000-4000-8000-000000000001",
      name: "old",
      messages: [{ role: "system", content: "sys" }],
      activeProfile: undefined,
      savedAt: "t",
      goalTrace: earlier,
    };
    const saves: Saves[] = [];
    const session = makeSession(client(), source(saves, saved));
    await text(session, "/resume aaaaaaaa");
    expect(await text(session, "/goal log")).toContain("EXIT blocked: needs a login");
    await text(session, "say hi");
    const last = saves.at(-1)?.trace ?? [];
    expect(last[0]).toEqual(earlier[0]!);
    expect(last.length).toBeGreaterThan(earlier.length);
    expect(last.at(-1)).toMatchObject({ kind: "exit", reason: "met" });
  });

  test("/new starts an empty trace", async () => {
    const session = makeSession(client(), source([]));
    await text(session, "say hi");
    await text(session, "/new");
    expect(await text(session, "/goal log")).toContain("no goal trace yet");
  });

  test("a turn that throws still leaves an exception exit in the saved session", async () => {
    const saves: Saves[] = [];
    const session = makeSession(client({ throws: true }), source(saves));
    await expect(session.handleLine("say hi")).rejects.toThrow("the model fell over");
    expect(saves.at(-1)?.trace?.at(-1)).toMatchObject({
      kind: "exit",
      reason: "exception",
      detail: expect.stringContaining("the model fell over"),
    });
  });
});
