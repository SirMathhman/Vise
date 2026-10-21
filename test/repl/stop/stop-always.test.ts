import { describe, expect, test } from "bun:test";
import type { CallPurpose, Client, Message, Tool, ToolRunner, Workflow } from "@vise/core";
import { Session, type LineResult } from "../../../packages/backend/src/repl/session.ts";
import type { ContextSource, SessionOptions } from "../../../packages/backend/src/repl/session.ts";

/**
 * Stop must work whatever the line is waiting on. Each case makes one stage of
 * a line hang (a promise that ignores the abort signal and only finishes when
 * the test lets it), presses Stop, and requires the line to end `interrupted`
 * at once; the hung work is then let finish, and must not change the
 * conversation afterwards.
 */

/** Work that only finishes when the test says so; it never looks at an abort signal. */
interface Hang {
  started: Promise<void>;
  promise: Promise<unknown>;
  release(): void;
}

function hang(lateValue: unknown): Hang {
  let markStarted!: () => void;
  const started = new Promise<void>((r) => (markStarted = r));
  let release!: () => void;
  const promise = new Promise<unknown>((resolve) => {
    release = () => resolve(lateValue);
  });
  let first = true;
  return {
    started,
    get promise() {
      if (first) markStarted();
      first = false;
      return promise;
    },
    release,
  };
}

const context: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  contextMax: async () => ({ ok: true, value: 100_000 }),
};

const late = (content: string) => ({ ok: true, value: { content } });
const GOAL = JSON.stringify({ goal: "g", done_when: "d", hold: "" });
const CHECK = JSON.stringify({ accomplished: "no", evidence: "", next_step: "keep going" });

/** A client whose calls for `purpose` hang; every other call answers at once. */
function clientHangingOn(purpose: CallPurpose | "none", h: Hang, toolCallFirst = false): Client {
  let replies = 0;
  const make = (as: CallPurpose): Client => ({
    as: (p) => make(p),
    chat: async () => {
      if (as === purpose) return h.promise as never;
      if (as === "goal") return late(GOAL) as never;
      if (as === "goal-check") return late(CHECK) as never;
      if (as === "compaction") return late("a summary of the conversation so far") as never;
      if (toolCallFirst && replies++ === 0) {
        const call = {
          type: "function" as const,
          id: "c1",
          function: { name: "t", arguments: "{}" },
        };
        return { ok: true, value: { content: "", tool_calls: [call] } };
      }
      return late("done") as never;
    },
  });
  return make("reply");
}

interface Case {
  name: string;
  line?: string;
  build(h: Hang): { client: Client; tools?: ToolRunner; options?: Partial<SessionOptions> };
  /** Lines run (to completion) before the one that is stopped. */
  before?: string[];
  /** The line's own work was already done (a post-turn hook): it may end with its reply instead. */
  finished?: boolean;
}

const toolT: Tool = {
  type: "function",
  function: { name: "t", description: "a tool", parameters: { type: "object", properties: {} } },
};

const okTools: ToolRunner = { run: async () => "out" };
const workflow: Workflow = { steps: [{ type: "tool", name: "t", args: {}, exact: true }] };

const CASES: Case[] = [
  {
    name: "a tool that never finishes",
    build: (h) => ({
      client: clientHangingOn("none", h, true),
      tools: { run: () => h.promise as Promise<string> },
    }),
  },
  {
    name: "a model call that ignores the signal",
    build: (h) => ({ client: clientHangingOn("reply", h) }),
  },
  {
    name: "a pre-turn hook",
    build: (h) => ({
      client: clientHangingOn("none", h),
      options: { preTurnHooks: [{ command: "slow", run: () => h.promise as Promise<string> }] },
    }),
  },
  {
    name: "a post-turn hook",
    finished: true,
    build: (h) => ({
      client: clientHangingOn("none", h),
      options: { postTurnHooks: [{ command: "slow", run: () => h.promise as Promise<string> }] },
    }),
  },
  {
    name: "the goal derivation",
    build: (h) => ({ client: clientHangingOn("goal", h), options: { goalChecking: true } }),
  },
  {
    name: "the goal check",
    build: (h) => ({ client: clientHangingOn("goal-check", h), options: { goalChecking: true } }),
  },
  {
    name: "/compact",
    line: "/compact",
    before: ["one", "two", "three", "four", "five", "six"],
    build: (h) => ({ client: clientHangingOn("compaction", h) }),
  },
  {
    name: "looking up a /shortcut",
    line: "/someNote",
    build: (h) => ({
      client: clientHangingOn("none", h),
      options: {
        noteSource: {
          listNotes: async () => ({ ok: true, value: [] }),
          initNote: async () => ({ ok: true, value: "" }),
          findNotes: () => h.promise as never,
        },
      },
    }),
  },
  {
    name: "a workflow step",
    line: "/workflow wf",
    build: (h) => ({
      client: clientHangingOn("none", h),
      tools: { run: () => h.promise as Promise<string> },
      options: {
        workflowSource: {
          listWorkflows: async () => ({ ok: true, value: [] }),
          loadWorkflow: async () => ({ ok: true, value: workflow }),
          initWorkflow: async () => ({ ok: true, value: "" }),
        },
      },
    }),
  },
];

const conversation = (s: Session): Message[] => (s as unknown as { messages: Message[] }).messages;

/** A line that has not ended within this long after Stop counts as Stop not working. */
const STOP_WITHIN_MS = 200;

async function stopWhileHung(c: Case): Promise<void> {
  const h = hang(
    c.name.includes("hook") ? "late hook output" : late("late answer that must be ignored"),
  );
  const { client, tools = okTools, options = {} } = c.build(h);
  const session = new Session(client, tools, [toolT], {
    context,
    preTurnHooks: [],
    postTurnHooks: [],
    ...options,
  });
  for (const line of c.before ?? []) await session.handleLine(line);
  const line = session.handleLine(c.line ?? "do the task");
  // A case whose line never reaches the hung stage is a broken case, not a pass.
  const reached = await Promise.race([
    h.started.then(() => true),
    line.then(() => false),
    Bun.sleep(2000).then(() => false),
  ]);
  expect(reached).toBe(true);
  expect(session.interrupt()).toBe(true);
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), STOP_WITHIN_MS));
  const result: LineResult | "timeout" = await Promise.race([line, timeout]);
  expect(result).not.toBe("timeout");
  if (!c.finished) expect(result).toEqual({ ok: false, error: { kind: "interrupted" } });
  // The hung work finishes after the user stopped it: nothing of it may land.
  const after = JSON.stringify(conversation(session));
  h.release();
  await Bun.sleep(10);
  expect(JSON.stringify(conversation(session))).toBe(after);
  // And the session is usable again.
  expect(session.interrupt()).toBe(false);
}

describe("Stop ends a line whatever it is waiting on", () => {
  for (const c of CASES) test(c.name, () => stopWhileHung(c));
});

test("a stopped tool call is answered in the conversation, so the next turn is well formed", async () => {
  const h = hang("late");
  const session = new Session(
    clientHangingOn("none", h, true),
    { run: () => h.promise as never },
    [],
    {
      context,
      preTurnHooks: [],
      postTurnHooks: [],
    },
  );
  const line = session.handleLine("go");
  await h.started;
  session.interrupt();
  await line;
  const messages = conversation(session);
  const call = messages.findLast((m) => m.tool_calls?.length);
  const answer = messages.findLast((m) => m.role === "tool");
  expect(answer?.tool_call_id).toBe(call?.tool_calls?.[0]?.id);
  expect(answer?.content.startsWith("error:")).toBe(true);
});

test("Stop with nothing running does nothing and says so", () => {
  const session = new Session(clientHangingOn("none", hang(null)), okTools, [], {
    context,
    preTurnHooks: [],
    postTurnHooks: [],
  });
  expect(session.interrupt()).toBe(false);
});
