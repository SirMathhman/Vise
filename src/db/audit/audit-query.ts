import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AuditReader, AuditReport, AuditTopic } from "../../core/audit.ts";
import { globalDataDir } from "../../data-dir.ts";
import { AUDIT_MIGRATIONS } from "./audit-schema.ts";
import { openDb } from "../open.ts";

type Row = Record<string, number | string | null>;

const one = (db: Database, sql: string, ...args: string[]): Row =>
  (db.query(sql).get(...args) ?? {}) as Row;
const all = (db: Database, sql: string, ...args: string[]): Row[] =>
  db.query(sql).all(...args) as Row[];
const num = (v: Row[string] | undefined): number => Number(v ?? 0);
const str = (v: Row[string] | undefined): string => String(v ?? "");

/** The counts `/audit` opens with, from one cheap query per table. */
function summary(db: Database, s: string): AuditReport {
  const turns = one(
    db,
    "SELECT COUNT(*) n, COALESCE(SUM(outcome != 'ok'), 0) bad FROM audit_turns WHERE session_id = ?",
    s,
  );
  const models = one(
    db,
    "SELECT COUNT(*) n, COALESCE(SUM(ms), 0) ms, COALESCE(SUM(error IS NOT NULL), 0) bad FROM audit_model_calls WHERE session_id = ?",
    s,
  );
  const tools = one(
    db,
    "SELECT COUNT(*) n, COALESCE(SUM(ok = 0), 0) bad FROM audit_tool_calls WHERE session_id = ?",
    s,
  );
  const named = (name: string): number =>
    num(
      one(
        db,
        "SELECT COUNT(*) n FROM audit_events WHERE session_id = ? AND name = ?",
        s,
        name,
      ).n,
    );
  return {
    topic: "summary",
    counts: {
      turns: num(turns.n),
      "failed turns": num(turns.bad),
      "model calls": num(models.n),
      "model errors": num(models.bad),
      "model seconds": Math.round(num(models.ms) / 1000),
      "tool calls": num(tools.n),
      "tool errors": num(tools.bad),
      "hook runs": named("hook_run"),
      compactions: named("compaction"),
      commands: named("command"),
    },
  };
}

function errors(db: Database, s: string): { what: string; detail: string }[] {
  const failed = (sql: string, what: (r: Row) => string) =>
    all(db, sql, s).map((r) => ({ what: what(r), detail: str(r.d) }));
  return [
    ...failed(
      "SELECT user_text t, error d FROM audit_turns WHERE session_id = ? AND outcome != 'ok'",
      (r) => `turn "${str(r.t).slice(0, 40)}"`,
    ),
    ...failed(
      "SELECT purpose p, error d FROM audit_model_calls WHERE session_id = ? AND error IS NOT NULL",
      (r) => `model call (${str(r.p)})`,
    ),
    ...failed(
      "SELECT name n, result d FROM audit_tool_calls WHERE session_id = ? AND ok = 0",
      (r) => `tool ${str(r.n)}`,
    ),
  ];
}

function toolRows(db: Database, s: string): AuditReport {
  const rows = all(
    db,
    `SELECT name, COUNT(*) calls, SUM(ok = 0) failures, AVG(ms) avg
     FROM audit_tool_calls WHERE session_id = ? GROUP BY name ORDER BY calls DESC`,
    s,
  );
  return {
    topic: "tools",
    rows: rows.map((r) => ({
      name: str(r.name),
      calls: num(r.calls),
      failures: num(r.failures),
      avgMs: Math.round(num(r.avg)),
    })),
  };
}

function modelRows(db: Database, s: string): AuditReport {
  const rows = all(
    db,
    `SELECT purpose, COUNT(*) calls, SUM(error IS NOT NULL) errors, AVG(ms) avg, MAX(prompt_tokens) tokens
     FROM audit_model_calls WHERE session_id = ? GROUP BY purpose ORDER BY calls DESC`,
    s,
  );
  return {
    topic: "models",
    rows: rows.map((r) => ({
      purpose: str(r.purpose),
      calls: num(r.calls),
      errors: num(r.errors),
      avgMs: Math.round(num(r.avg)),
      maxPromptTokens: num(r.tokens),
    })),
  };
}

function hookRows(db: Database, s: string): AuditReport {
  const rows = all(
    db,
    `SELECT json_extract(payload, '$.phase') phase, json_extract(payload, '$.command') command,
            json_extract(payload, '$.ms') ms, json_extract(payload, '$.output') output
     FROM audit_events WHERE session_id = ? AND name = 'hook_run' ORDER BY id`,
    s,
  );
  return {
    topic: "hooks",
    rows: rows.map((r) => ({
      phase: str(r.phase),
      command: str(r.command),
      ms: Math.round(num(r.ms)),
      output: str(r.output),
    })),
  };
}

const REPORTS: Record<AuditTopic, (db: Database, s: string) => AuditReport> = {
  summary,
  tools: toolRows,
  models: modelRows,
  errors: (db, s) => ({ topic: "errors", rows: errors(db, s) }),
  hooks: hookRows,
};

/** Reads `~/.vise/audit.db`; `flush` first makes what is still queued visible. */
export class SqliteAuditReader implements AuditReader {
  constructor(
    private readonly flush: () => void,
    private readonly path: string = join(globalDataDir, "audit.db"),
  ) {}

  private db(): Database {
    this.flush();
    const opened = openDb(this.path, AUDIT_MIGRATIONS);
    if (!opened.ok) throw new Error(JSON.stringify(opened.error));
    return opened.value;
  }

  report(session: string, topic: AuditTopic): AuditReport {
    return REPORTS[topic](this.db(), session);
  }

  /** Find text in any recorded message or tool result, across every conversation. */
  search(text: string): AuditReport {
    const phrase = `"${text.replace(/"/g, '""')}"`;
    const rows = all(
      this.db(),
      `SELECT kind, session_id s, snippet(audit_fts, 0, '[', ']', '...', 12) sn
       FROM audit_fts WHERE audit_fts MATCH ? ORDER BY rank LIMIT 20`,
      phrase,
    );
    return {
      topic: "search",
      rows: rows.map((r) => ({
        kind: str(r.kind),
        session: str(r.s),
        snippet: str(r.sn),
      })),
    };
  }
}
