import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "../../src/core/errors.ts";
import type { GoalTraceEntry } from "../../src/core/goal-trace.ts";
import { closeAllDbs, openDb } from "../../src/db/open.ts";
import { SESSION_MIGRATIONS } from "../../src/db/session/session-schema.ts";
import {
  deleteSession,
  loadSession,
  saveSession,
  searchSessions,
} from "../../src/stores/sessions.ts";

const base = (): string => mkdtempSync(join(tmpdir(), "goal-trace-"));

const messages: Message[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "fix the build", typed: true },
  { role: "assistant", content: "done" },
];

const trace: GoalTraceEntry[] = [
  { kind: "turn_start", line: "fix the build", enabled: true, at: "2026-10-09T01:00:00.000Z", after: 2 },
  { kind: "ask", purpose: "goal-check", attempt: 1, question: "[goal check] zebrafish?", reply: "{\"verdict\":\"yes\"}", at: "2026-10-09T01:00:01.000Z", after: 3 },
  { kind: "exit", reason: "met", detail: "ok", lastReply: "done", toolResults: 0, at: "2026-10-09T01:00:02.000Z", after: 3 },
];

const rows = (dir: string, sql: string): unknown[] => {
  const db = new Database(join(dir, "vise.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
};

describe("the goal trace in a saved session", () => {
  test("is saved and loaded with the session, apart from the conversation", () => {
    const dir = base();
    const withTrace = saveSession(dir, undefined, "a", messages, undefined, [], trace);
    const without = saveSession(dir, undefined, "b", messages, undefined);
    if (!withTrace.ok || !without.ok) throw new Error("save failed");
    const a = loadSession(dir, withTrace.value);
    const b = loadSession(dir, without.value);
    if (!a.ok || !b.ok) throw new Error("load failed");
    expect(a.value.goalTrace).toEqual(trace);
    expect(b.value.goalTrace).toEqual([]);
    // Loading strips it: the conversation is exactly what was saved, trace or no trace.
    expect(a.value.messages).toEqual(b.value.messages);
    expect(a.value.messages).toEqual(messages);
  });

  test("a later save replaces the trace instead of adding to it", () => {
    const dir = base();
    const first = saveSession(dir, undefined, "a", messages, undefined, [], trace);
    if (!first.ok) throw new Error("save failed");
    saveSession(dir, first.value, "a", messages, undefined, [], trace.slice(0, 2));
    expect(rows(dir, "select seq from goal_trace order by seq")).toEqual([{ seq: 0 }, { seq: 1 }]);
  });

  test("deleting the session deletes its trace", () => {
    const dir = base();
    const saved = saveSession(dir, undefined, "a", messages, undefined, [], trace);
    if (!saved.ok) throw new Error("save failed");
    expect(deleteSession(dir, saved.value).ok).toBeTrue();
    expect(rows(dir, "select count(*) as n from goal_trace")).toEqual([{ n: 0 }]);
  });

  test("is not found by searching sessions", () => {
    const dir = base();
    saveSession(dir, undefined, "a", messages, undefined, [], trace);
    const hits = searchSessions(dir, "zebrafish");
    expect(hits.ok && hits.value).toEqual([]);
    const real = searchSessions(dir, "build");
    expect(real.ok && real.value.length).toBe(1);
  });

  test("a database from before the trace existed is upgraded and keeps its sessions", () => {
    const dir = base();
    const old = openDb(join(dir, "vise.db"), SESSION_MIGRATIONS.slice(0, 2));
    if (!old.ok) throw new Error("open failed");
    old.value.query(
      "INSERT INTO sessions (id, name, active_profile, created_at, updated_at) VALUES ('11111111-0000-4000-8000-000000000001', 'old', NULL, 't', 't')",
    ).run();
    // A real upgrade happens in a new process; connections are cached per file here.
    closeAllDbs();
    const loaded = loadSession(dir, "11111111");
    expect(loaded.ok && loaded.value.name).toBe("old");
    expect(loaded.ok && loaded.value.goalTrace).toEqual([]);
    expect(rows(dir, "select count(*) as n from goal_trace")).toEqual([{ n: 0 }]);
  });
});
