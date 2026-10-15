import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteAuditSink } from "../../packages/backend/src/db/audit/audit-store.ts";
import { SqliteAuditReader } from "../../packages/backend/src/db/audit/audit-query.ts";
import { AUDIT_MIGRATIONS } from "../../packages/backend/src/db/audit/audit-schema.ts";
import { closeAllDbs, openDb } from "../../packages/backend/src/db/open.ts";
import { formatAuditReport } from "../../packages/backend/src/output/audit-format.ts";
import type { AuditCall } from "@vise/core";

const dir = mkdtempSync(join(tmpdir(), "vise-audit-calls-"));
afterAll(() => {
  closeAllDbs();
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
function fresh() {
  const path = join(dir, `audit-${n++}.db`);
  const sink = new SqliteAuditSink("/proj", path);
  const reader = new SqliteAuditReader(() => sink.flush(), path);
  sink.record({ kind: "session_start", session: "s1" });
  return { path, sink, reader };
}

describe("model calls in the audit log", () => {
  test("a call is on record from its start, and updated when it ends", () => {
    const { sink, reader } = fresh();
    sink.record({ kind: "model_call_start", request: 1, purpose: "reply", model: "m" });
    let rows = (reader.calls("s1", 10) as { rows: AuditCall[] }).rows;
    expect(rows).toMatchObject([{ request: 1, state: "running", purpose: "reply" }]);

    sink.record({
      kind: "model_call",
      request: 1,
      purpose: "reply",
      model: "m",
      ms: 1500,
      content: "hi",
      raw: "<|tool_call|>{...}",
      completionTokens: 42,
      finishReason: "stop",
    });
    rows = (reader.calls("s1", 10) as { rows: AuditCall[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "done",
      completionTokens: 42,
      finishReason: "stop",
      ms: 1500,
    });
  });

  test("progress keeps the raw text of a call that never ends", () => {
    const { sink, reader } = fresh();
    sink.record({ kind: "model_call_start", request: 7, purpose: "reply", model: "m" });
    sink.record({
      kind: "model_call_progress",
      request: 7,
      completionTokens: 900,
      raw: "still writing the same thing",
      rawReasoning: "hmm",
    });
    const report = reader.call("s1", 7);
    expect(report).toMatchObject({
      topic: "call",
      call: { state: "running", raw: "still writing the same thing", completionTokens: 900 },
    });
  });

  test("a call the guard stopped says why, and what repeated", () => {
    const { sink, reader } = fresh();
    sink.record({ kind: "model_call_start", request: 2, purpose: "reply", model: "m" });
    sink.record({
      kind: "model_call",
      request: 2,
      purpose: "reply",
      model: "m",
      ms: 9000,
      error: "vise: stopped a runaway model call",
      raw: "abc".repeat(1000),
      completionTokens: 17_000,
      stopReason: "loop",
      loop: { period: 3, repeats: 600 },
    });
    const report = reader.call("s1", 2);
    expect(report).toMatchObject({
      call: { state: "stopped", stopReason: "loop", loop: { period: 3, repeats: 600 } },
    });
    const text = formatAuditReport(report);
    expect(text).toContain("STOPPED: repeating itself");
    expect(text).toContain("repeated about 600 times");
    expect(formatAuditReport(reader.calls("s1", 5))).toContain(
      "#2 reply: STOPPED: repeating itself",
    );
  });

  test("a call with no record says so", () => {
    const { reader } = fresh();
    expect(formatAuditReport(reader.call("s1", 99))).toContain("no model call #99");
  });

  test("a call left running by a program that died is marked abandoned", () => {
    const { path, sink, reader } = fresh();
    sink.record({ kind: "model_call_start", request: 3, purpose: "reply", model: "m" });
    sink.flush();
    const opened = openDb(path, AUDIT_MIGRATIONS);
    if (!opened.ok) throw new Error("db");
    opened.value
      .query("UPDATE audit_model_calls SET updated_at = '2020-01-01T00:00:00.000Z'")
      .run();
    // A new process opens the log and writes something.
    const next = new SqliteAuditSink("/proj", path);
    next.record({ kind: "session_start", session: "s2" });
    next.flush();
    const rows = (reader.calls("s1", 10) as { rows: AuditCall[] }).rows;
    expect(rows[0]?.state).toBe("abandoned");
  });
});
