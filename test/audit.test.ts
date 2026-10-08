import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, AuditSink } from "../src/core/audit.ts";
import { LlmClient } from "../src/client/llm.ts";
import {
  runSubagent,
  type Client,
  type ToolRunner,
} from "../src/core/engine.ts";
import type { Message } from "../src/core/errors.ts";
import { runCompaction } from "../src/repl/compaction.ts";
import { createToolRunner, ToolSet } from "../src/tools.ts";
import { SqliteAuditSink } from "../src/db/audit-store.ts";
import { closeAllDbs } from "../src/db/open.ts";
import { Session } from "../src/repl/session.ts";
import type { ContextSource } from "../src/repl/session.ts";

const dir = mkdtempSync(join(tmpdir(), "vise-audit-"));
afterAll(() => {
  closeAllDbs();
  rmSync(dir, { recursive: true, force: true });
});

const context: ContextSource = {
  lastPromptTokensUsed: () => undefined,
  async contextMax() {
    return { ok: true, value: 100_000 };
  },
};
const tools: ToolRunner = { run: async () => "out" };
const base = { context, preTurnHooks: [], postTurnHooks: [] };

function recorder(): AuditSink & { events: AuditEvent[] } {
  const events: AuditEvent[] = [];
  return { events, record: (e) => void events.push(e) };
}

describe("Session audit events", () => {
  const ok: Client = {
    chat: async () => ({ ok: true, value: { content: "reply" } }),
  };

  test("a turn records its start, messages and end", async () => {
    const sink = recorder();
    const s = new Session(ok, tools, [], { ...base, auditSink: sink });
    await s.handleLine("hello");
    const kinds = sink.events.map((e) => e.kind);
    expect(kinds[0]).toBe("session_start");
    expect(kinds).toContain("turn_start");
    expect(kinds.at(-1)).toBe("turn_end");
    const roles = sink.events.flatMap((e) =>
      e.kind === "message" ? [e.message.role] : [],
    );
    expect(roles).toEqual(["system", "user", "assistant"]);
  });

  test("a failed turn is recorded as failed", async () => {
    const sink = recorder();
    const bad: Client = {
      chat: async () => ({
        ok: false,
        error: { kind: "network", cause: "down" },
      }),
    };
    await new Session(bad, tools, [], { ...base, auditSink: sink }).handleLine(
      "hi",
    );
    const end = sink.events.find((e) => e.kind === "turn_end");
    expect(end).toMatchObject({ outcome: "failed" });
  });

  test("a slash command is recorded as an event", async () => {
    const sink = recorder();
    await new Session(ok, tools, [], { ...base, auditSink: sink }).handleLine(
      "/context",
    );
    expect(sink.events).toContainEqual(
      expect.objectContaining({ kind: "event", name: "command" }),
    );
  });
});

describe("SqliteAuditSink", () => {
  test("writes sessions, turns, messages and events", () => {
    const path = join(dir, "a.db");
    const sink = new SqliteAuditSink("/proj", path);
    sink.record({ kind: "session_start", session: "s1" });
    sink.record({ kind: "turn_start", turn: "t1", text: "hi" });
    sink.record({
      kind: "message",
      message: { role: "user", content: "hi", typed: true },
    });
    sink.record({
      kind: "event",
      name: "command",
      payload: { line: "/x" },
    });
    sink.record({ kind: "link", saved: "abc" });
    sink.record({ kind: "turn_end", outcome: "ok" });
    sink.close();
    const db = new Database(path, { readonly: true });
    expect(
      db.query("SELECT root, saved_session_id FROM audit_sessions").get(),
    ).toEqual({ root: "/proj", saved_session_id: "abc" });
    expect(db.query("SELECT outcome FROM audit_turns").get()).toEqual({
      outcome: "ok",
    });
    expect(db.query("SELECT role, typed FROM audit_messages").get()).toEqual({
      role: "user",
      typed: 1,
    });
    expect(db.query("SELECT name, payload FROM audit_events").get()).toEqual({
      name: "command",
      payload: '{"line":"/x"}',
    });
    db.close();
  });

  test("never throws when the database cannot be opened", () => {
    const sink = new SqliteAuditSink("/proj", join(dir, "no\0such", "x.db"));
    sink.record({ kind: "session_start", session: "s" });
    expect(() => sink.close()).not.toThrow();
  });
});

const echoDefs = [
  {
    type: "function" as const,
    function: { name: "echo", description: "", parameters: {} },
  },
];

describe("what the capture points record", () => {
  const ok: Client = {
    chat: async () => ({ ok: true, value: { content: "reply" } }),
  };

  test("a tool call is recorded with its whole result and depth", async () => {
    const sink = recorder();
    const controller = new ToolSet(echoDefs);
    const runner = createToolRunner(
      { echo: async (args) => `echo ${String(args.x)}` },
      controller,
      dir,
      echoDefs,
      undefined,
      undefined,
      sink,
    );
    await runner.run("echo", { x: 1 });
    await runner.run("nope", {});
    const calls = sink.events.filter((e) => e.kind === "tool_call");
    expect(calls).toMatchObject([
      { name: "echo", result: "echo 1", ok: true, depth: 0 },
      { name: "nope", ok: false },
    ]);
  });

  test("a model call is recorded with its purpose and reply", async () => {
    const sink = recorder();
    const client = new LlmClient();
    client.setAuditSink(sink);
    const real = globalThis.fetch;
    const body =
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"choices":[],"usage":{"prompt_tokens":7}}\n\ndata: [DONE]\n\n';
    globalThis.fetch = (async () =>
      new Response(body, { status: 200 })) as unknown as typeof fetch;
    try {
      await client.as("goal").chat([{ role: "user", content: "x" }]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sink.events).toMatchObject([
      { kind: "model_call", purpose: "goal", content: "hi", promptTokens: 7 },
    ]);
  });

  test("a hook run is recorded", async () => {
    const sink = recorder();
    const hook = { command: "check", run: async () => "all good" };
    const s = new Session(ok, tools, [], {
      context,
      preTurnHooks: [hook],
      postTurnHooks: [],
      auditSink: sink,
    });
    await s.handleLine("go");
    expect(sink.events).toContainEqual(
      expect.objectContaining({
        kind: "hook_run",
        phase: "pre",
        command: "check",
        output: "all good",
      }),
    );
  });

  test("a compaction records the summary and counts", async () => {
    const sink = recorder();
    const conversation: Message[] = [{ role: "system", content: "sys" }];
    for (let i = 0; i < 8; i++) {
      conversation.push({ role: "user", content: `q${i}` });
      conversation.push({ role: "assistant", content: `a${i}` });
    }
    const result = await runCompaction({
      client: { chat: async () => ({ ok: true, value: { content: "SUM" } }) },
      messages: () => [...conversation],
      resetMessages: () => undefined,
      audit: sink,
    });
    expect(result.ok).toBe(true);
    expect(sink.events).toMatchObject([{ kind: "compaction", summary: "SUM" }]);
  });

  test("a subagent's conversation is handed over when it ends", async () => {
    const seen: Message[][] = [];
    await runSubagent(
      ok,
      tools,
      [],
      { role: "system", content: "sys" },
      "",
      "do it",
      { onSubagentDone: (m) => void seen.push(m) },
    );
    expect(seen[0]?.map((m) => m.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  test("a failed turn is still saved", async () => {
    const saves: Message[][] = [];
    const bad: Client = {
      chat: async () => ({
        ok: false,
        error: { kind: "network", cause: "down" },
      }),
    };
    const s = new Session(bad, tools, [], {
      ...base,
      sessionSource: {
        save: async (_id, _name, messages) => {
          saves.push(messages);
          return { ok: true, value: "id" };
        },
        load: async () => ({ ok: false, error: { kind: "interrupted" } }),
        list: async () => ({ ok: true, value: [] }),
        delete: async () => ({ ok: false, error: { kind: "interrupted" } }),
      },
    });
    await s.handleLine("hello");
    expect(saves).toHaveLength(1);
    expect(saves[0]?.some((m) => m.content === "hello")).toBe(true);
  });
});
