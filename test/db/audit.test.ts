import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, AuditSink } from "@vise/core";
import { LlmClient } from "../../packages/backend/src/client/llm.ts";
import { runSubagent, type Client, type ToolRunner } from "@vise/core";
import type { Message } from "@vise/core";
import { runCompaction } from "../../packages/backend/src/repl/turn/compaction.ts";
import { createToolRunner, ToolSet } from "../../packages/backend/src/tools.ts";
import { SqliteAuditSink } from "../../packages/backend/src/db/audit/audit-store.ts";
import { SqliteAuditReader } from "../../packages/backend/src/db/audit/audit-query.ts";
import { exportAudit } from "../../packages/backend/src/db/audit/audit-export.ts";
import { BY_SESSION, pruneAudit } from "../../packages/backend/src/db/audit/audit-prune.ts";
import { AUDIT_MIGRATIONS } from "../../packages/backend/src/db/audit/audit-schema.ts";
import { closeAllDbs, openDb } from "../../packages/backend/src/db/open.ts";
import { Session, type LineResult } from "../../packages/backend/src/repl/session.ts";
import type { ContextSource } from "../../packages/backend/src/repl/session.ts";

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
    const roles = sink.events.flatMap((e) => (e.kind === "message" ? [e.message.role] : []));
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
    await new Session(bad, tools, [], { ...base, auditSink: sink }).handleLine("hi");
    const end = sink.events.find((e) => e.kind === "turn_end");
    expect(end).toMatchObject({ outcome: "failed" });
  });

  test("a slash command is recorded as an event", async () => {
    const sink = recorder();
    await new Session(ok, tools, [], { ...base, auditSink: sink }).handleLine("/context");
    expect(sink.events).toContainEqual(expect.objectContaining({ kind: "event", name: "command" }));
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
    expect(db.query("SELECT root, saved_session_id FROM audit_sessions").get()).toEqual({
      root: "/proj",
      saved_session_id: "abc",
    });
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
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;
    try {
      await client.as("goal").chat([{ role: "user", content: "x" }]);
    } finally {
      globalThis.fetch = real;
    }
    expect(sink.events).toMatchObject([
      { kind: "model_call_start", purpose: "goal", request: 1 },
      {
        kind: "model_call",
        purpose: "goal",
        content: "hi",
        promptTokens: 7,
        request: 1,
        raw: "hi",
      },
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
      conversation.push({ role: "user", content: `q${i} ${"x".repeat(300)}` });
      conversation.push({ role: "assistant", content: `a${i} ${"y".repeat(300)}` });
    }
    const result = await runCompaction({
      client: { chat: async () => ({ ok: true, value: { content: `SUM${"z".repeat(400)}` } }) },
      messages: () => [...conversation],
      resetMessages: () => undefined,
      audit: sink,
    });
    expect(result.ok).toBe(true);
    expect(sink.events).toMatchObject([
      { kind: "compaction", summary: expect.stringContaining("SUM") },
    ]);
  });

  test("a subagent's conversation is handed over when it ends", async () => {
    const seen: Message[][] = [];
    await runSubagent(ok, tools, [], { role: "system", content: "sys" }, "", "do it", {
      onSubagentDone: (m) => void seen.push(m),
    });
    expect(seen[0]?.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
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

/** The text of a command's answer ("" when it failed). */
function out(result: LineResult): string {
  return result !== "exit" && result.ok ? result.value : "";
}

describe("reading the audit log", () => {
  function logged(name: string) {
    const path = join(dir, `${name}.db`);
    const sink = new SqliteAuditSink("/proj", path);
    const reader = new SqliteAuditReader(() => sink.flush(), path);
    return { path, sink, reader };
  }
  const reply: Client = {
    chat: async () => ({ ok: true, value: { content: "the answer is 42" } }),
  };

  test("/audit summarises the conversation and /audit search finds its text", async () => {
    const { sink, reader } = logged("read1");
    const s = new Session(reply, tools, [], {
      ...base,
      auditSink: sink,
      auditReader: reader,
    });
    await s.handleLine("what is it");
    const summary = await s.handleLine("/audit");
    expect(out(summary)).toContain("turns: 1");
    const found = await s.handleLine("/audit search 42");
    expect(out(found)).toContain("[42]");
    expect(out(await s.handleLine("/audit bogus"))).toBe("");
  });

  test("/audit errors lists a failed turn", async () => {
    const { sink, reader } = logged("read2");
    const down: Client = {
      chat: async () => ({
        ok: false,
        error: { kind: "network", cause: "down" },
      }),
    };
    const s = new Session(down, tools, [], {
      ...base,
      auditSink: sink,
      auditReader: reader,
    });
    await s.handleLine("hello");
    const errors = await s.handleLine("/audit errors");
    expect(out(errors)).toContain("down");
  });

  test("/audit says so when the log is off", async () => {
    const s = new Session(reply, tools, [], base);
    const result = await s.handleLine("/audit");
    expect(out(result)).toBe("");
  });

  test("pruning removes whole old conversations and keeps recent ones", () => {
    const { path, sink } = logged("prune");
    sink.record({ kind: "session_start", session: "old" });
    sink.record({
      kind: "message",
      message: { role: "user", content: "old news" },
    });
    sink.record({ kind: "session_end" });
    sink.record({ kind: "session_start", session: "new" });
    sink.record({
      kind: "message",
      message: { role: "user", content: "fresh" },
    });
    sink.close();
    const db = openDb(path, AUDIT_MIGRATIONS);
    if (!db.ok) throw new Error("open failed");
    db.value
      .query(
        "UPDATE audit_sessions SET started_at = '2000-01-01', ended_at = '2000-01-02' WHERE id = 'old'",
      )
      .run();
    expect(pruneAudit(db.value, "2020-01-01")).toBe(1);
    const left = db.value.query("SELECT session_id FROM audit_messages").all();
    expect(left).toEqual([{ session_id: "new" }]);
    expect(
      db.value.query("SELECT COUNT(*) n FROM audit_fts WHERE audit_fts MATCH 'old'").get(),
    ).toEqual({ n: 0 });
  });

  test("pruning keeps a conversation that is still in use, even one that began long ago", () => {
    const { path, sink } = logged("prune-live");
    sink.record({ kind: "session_start", session: "live" });
    sink.record({ kind: "message", message: { role: "user", content: "now" } });
    sink.record({ kind: "session_start", session: "dead" });
    sink.record({ kind: "message", message: { role: "user", content: "x" } });
    sink.close();
    const db = openDb(path, AUDIT_MIGRATIONS);
    if (!db.ok) throw new Error("open failed");
    db.value.query("UPDATE audit_sessions SET started_at = '2000-01-01'").run();
    db.value.query("UPDATE audit_messages SET ts = '2000-01-02' WHERE session_id = 'dead'").run();
    expect(pruneAudit(db.value, "2020-01-01")).toBe(1);
    expect(db.value.query("SELECT id FROM audit_sessions").all()).toEqual([{ id: "live" }]);
  });

  test("every audit table keyed by session_id is pruned", () => {
    const { path, sink } = logged("prune-tables");
    sink.close();
    sink.record({ kind: "session_start", session: "s" });
    sink.close();
    const db = openDb(path, AUDIT_MIGRATIONS);
    if (!db.ok) throw new Error("open failed");
    const keyed = db.value
      .query(
        "SELECT DISTINCT m.name name FROM sqlite_master m, pragma_table_info(m.name) p WHERE m.type = 'table' AND p.name = 'session_id'",
      )
      .all() as { name: string }[];
    expect(keyed.map((r) => r.name).sort()).toEqual([...BY_SESSION].sort());
  });

  test("an export holds everything recorded for a conversation", () => {
    const { path, sink } = logged("export");
    sink.record({ kind: "session_start", session: "abc123" });
    sink.record({ kind: "turn_start", turn: "t", text: "hi" });
    sink.record({ kind: "message", message: { role: "user", content: "hi" } });
    sink.record({ kind: "turn_end", outcome: "ok" });
    const data = exportAudit("abc", path);
    expect(data.ok && data.value).toMatchObject({
      session: { id: "abc123", root: "/proj" },
      turns: [{ user_text: "hi", outcome: "ok" }],
      messages: [{ content: "hi" }],
    });
    const missing = exportAudit("zzz", path);
    expect(!missing.ok && missing.error.kind).toBe("malformed");
  });
});
