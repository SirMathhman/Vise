import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type {
  AuditCall,
  AuditReader,
  AuditReport,
  AuditTopic,
} from "../../core/audit.ts";
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

const STATES = ["running", "done", "stopped", "error", "abandoned"] as const;

/** A recorded model call as the report shows it. */
function callOf(r: Row, full: boolean): AuditCall {
  const state = STATES.find((s) => s === r.state) ?? "done";
  const raw = r.raw === null || r.raw === undefined ? undefined : str(r.raw);
  const reasoning = r.raw_reasoning === null || r.raw_reasoning === undefined ? undefined : str(r.raw_reasoning);
  return {
    request: num(r.request),
    purpose: str(r.purpose),
    model: str(r.model),
    state,
    stopReason: r.stop_reason === null || r.stop_reason === undefined ? undefined : str(r.stop_reason),
    ms: num(r.ms),
    promptTokens: r.prompt_tokens === null ? undefined : num(r.prompt_tokens),
    completionTokens: r.completion_tokens === null ? undefined : num(r.completion_tokens),
    finishReason: r.finish_reason === null || r.finish_reason === undefined ? undefined : str(r.finish_reason),
    toolCalls: r.tool_calls === null ? undefined : num(r.tool_calls),
    error: r.error === null || r.error === undefined ? undefined : str(r.error),
    rawChars: raw?.length,
    raw: full ? raw : undefined,
    reasoning: full ? reasoning : undefined,
    reasoningChars: reasoning?.length,
    loop: r.loop_period === null || r.loop_period === undefined ? undefined : { period: num(r.loop_period), repeats: num(r.loop_repeats) },
    startedAt: r.started_at === null || r.started_at === undefined ? undefined : str(r.started_at),
  };
}

const CALL_COLUMNS = `request, purpose, model, state, stop_reason, ms, prompt_tokens, completion_tokens,
  finish_reason, tool_calls, error, raw, raw_reasoning, loop_period, loop_repeats, started_at`;

/** Reads `~/.vise/audit.db`; `flush` first makes what is still queued visible. */
export class SqliteAuditReader implements AuditReader {
  constructor(
    private readonly flush: () => void,
    private readonly path: string = join(globalDataDir, "audit.db"),
    /** The calls this process still has in memory (running ones with their live text); they win over the stored rows. */
    private readonly live: () => AuditCall[] = () => [],
  ) {}

  calls(session: string, limit: number): AuditReport {
    const stored = all(
      this.db(),
      `SELECT ${CALL_COLUMNS} FROM audit_model_calls
        WHERE session_id = ? AND request IS NOT NULL ORDER BY id DESC LIMIT ${Math.max(1, Math.floor(limit))}`,
      session,
    ).map((r) => callOf(r, false));
    const live = new Map(this.live().map((c) => [c.request, c]));
    const rows = stored.map((c) => {
      const fresh = live.get(c.request);
      return fresh ? { ...fresh, raw: undefined, reasoning: undefined } : c;
    });
    return { topic: "calls", rows };
  }

  call(session: string, request: number): AuditReport {
    const fresh = this.live().find((c) => c.request === request);
    const row = one(
      this.db(),
      `SELECT ${CALL_COLUMNS} FROM audit_model_calls WHERE session_id = ? AND request = ${Math.floor(request)} ORDER BY id DESC LIMIT 1`,
      session,
    );
    const stored = row.request === undefined ? undefined : callOf(row, true);
    return { topic: "call", request, call: fresh ?? stored };
  }

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
