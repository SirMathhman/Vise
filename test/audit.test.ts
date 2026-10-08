import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuditEvent, AuditSink } from "../src/core/audit.ts";
import type { Client, ToolRunner } from "../src/core/engine.ts";
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
    sink.record({ kind: "turn_start", session: "s1", turn: "t1", text: "hi" });
    sink.record({
      kind: "message",
      session: "s1",
      turn: "t1",
      message: { role: "user", content: "hi", typed: true },
    });
    sink.record({
      kind: "event",
      session: "s1",
      turn: "t1",
      name: "command",
      payload: { line: "/x" },
    });
    sink.record({ kind: "link", session: "s1", saved: "abc" });
    sink.record({ kind: "turn_end", turn: "t1", outcome: "ok" });
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
