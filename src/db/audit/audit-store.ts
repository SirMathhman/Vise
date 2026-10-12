import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AuditEvent, AuditSink } from "@vise/core";
import { globalDataDir } from "../../data-dir.ts";
import { AUDIT_MIGRATIONS } from "./audit-schema.ts";
import { openDb, tryDb } from "../open.ts";

/** Longest wait before queued events are written. */
const FLUSH_MS = 250;
/** A call marked running and not updated for this long was left by a process that is gone. */
const STALE_RUNNING_MS = 10 * 60_000;
/** Longest text kept in one field; the rest is cut and the cut is noted. */
const MAX_TEXT = 200_000;

function clip(text: string): string {
  return text.length <= MAX_TEXT
    ? text
    : `${text.slice(0, MAX_TEXT)}\n[audit: cut ${text.length - MAX_TEXT} characters]`;
}

const clipped = (text: string | undefined): string | null =>
  text === undefined ? null : clip(text);

/** Where an event belongs: the conversation and turn it arrived in. */
interface Place {
  session: string;
  turn: string | null;
  ts: string;
}

/**
 * The audit log in `~/.vise/audit.db`. `record` only queues the event; the
 * queue is written in one transaction a moment later, when a turn or
 * conversation ends, or on `close`, so recording never slows a turn. Events
 * arrive in the order they happened, so the sink itself follows which
 * conversation and turn they belong to. Never throws: a write that fails is
 * reported once on stderr and its events are dropped (an audit failure must
 * not break the agent).
 */
export class SqliteAuditSink implements AuditSink {
  private queue: { event: AuditEvent; ts: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  /** Events lost because a write failed. */
  dropped = 0;
  private readonly path: string;
  private session = "";
  private turn: string | null = null;

  constructor(
    private readonly root: string,
    dbPath: string = join(globalDataDir, "audit.db"),
  ) {
    this.path = dbPath;
  }

  record(event: AuditEvent): void {
    this.queue.push({ event, ts: new Date().toISOString() });
    if (event.kind === "turn_end" || event.kind === "session_end") {
      this.flush();
    } else if (this.timer === undefined) {
      this.timer = setTimeout(() => this.flush(), FLUSH_MS);
      this.timer.unref?.();
    }
  }

  /** Write everything queued. */
  flush(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const batch = this.queue;
    this.queue = [];
    if (batch.length === 0) return;
    const opened = openDb(this.path, AUDIT_MIGRATIONS);
    const written = opened.ok
      ? tryDb("write the audit log", this.path, () =>
          opened.value.transaction(() => {
            this.sweepAbandoned(opened.value);
            for (const q of batch) this.write(opened.value, q.event, q.ts);
          })(),
        )
      : opened;
    if (!written.ok) this.dropped += batch.length;
    if (!written.ok && !this.warned) {
      this.warned = true;
      console.error(
        `vise: audit log not written (${JSON.stringify(written.error)})`,
      );
    }
  }

  private swept = false;

  /** Once per process: calls still marked running that nothing has touched for a while belong to a process that died. */
  private sweepAbandoned(db: Database): void {
    if (this.swept) return;
    this.swept = true;
    const cutoff = new Date(Date.now() - STALE_RUNNING_MS).toISOString();
    db.query(
      "UPDATE audit_model_calls SET state = 'abandoned' WHERE state = 'running' AND updated_at < ?",
    ).run(cutoff);
  }

  /** Flush and stop (the session is closing). */
  close(): void {
    this.flush();
  }

  private write(db: Database, e: AuditEvent, ts: string): void {
    if (e.kind === "session_start") this.session = e.session;
    if (e.kind === "turn_start") this.turn = e.turn;
    const at: Place = { session: this.session, turn: this.turn, ts };
    (WRITERS[e.kind] as Writer<typeof e.kind>)(db, e as never, at, this.root);
    if (e.kind === "turn_end") this.turn = null;
  }
}

type Writer<K extends AuditEvent["kind"]> = (
  db: Database,
  e: Extract<AuditEvent, { kind: K }>,
  at: Place,
  root: string,
) => void;

const WRITERS: { [K in AuditEvent["kind"]]: Writer<K> } = {
  session_start: (db, e, at, root) => {
    db.query(
      "INSERT OR IGNORE INTO audit_sessions (id, root, started_at) VALUES (?, ?, ?)",
    ).run(e.session, root, at.ts);
  },
  session_end: (db, _e, at) => {
    db.query("UPDATE audit_sessions SET ended_at = ? WHERE id = ?").run(
      at.ts,
      at.session,
    );
  },
  link: (db, e, at) => {
    db.query("UPDATE audit_sessions SET saved_session_id = ? WHERE id = ?").run(
      e.saved,
      at.session,
    );
  },
  turn_start: (db, e, at) => {
    db.query(
      "INSERT INTO audit_turns (id, session_id, user_text, started_at) VALUES (?, ?, ?, ?)",
    ).run(e.turn, at.session, clip(e.text), at.ts);
  },
  turn_end: (db, e, at) => {
    db.query(
      "UPDATE audit_turns SET ended_at = ?, outcome = ?, error = ? WHERE id = ?",
    ).run(at.ts, e.outcome, clipped(e.error), at.turn);
  },
  message: (db, e, at) => {
    const m = e.message;
    index(db, at, "message", m.content);
    db.query(
      `INSERT INTO audit_messages
         (session_id, turn_id, ts, role, content, typed, tool_calls, tool_call_id, images, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      at.session,
      at.turn,
      at.ts,
      m.role,
      clip(m.content),
      m.typed === undefined ? null : m.typed ? 1 : 0,
      m.tool_calls ? clip(JSON.stringify(m.tool_calls)) : null,
      m.tool_call_id ?? null,
      m.images ? JSON.stringify(m.images) : null,
      e.depth ?? 0,
    );
  },
  model_call_start: (db, e, at) => {
    db.query(
      `INSERT INTO audit_model_calls
         (session_id, turn_id, ts, purpose, model, ms, request, state, started_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'running', ?, ?)`,
    ).run(at.session, at.turn, at.ts, e.purpose, e.model, e.request, at.ts, at.ts);
  },
  model_call_progress: (db, e, at) => {
    db.query(
      `UPDATE audit_model_calls
          SET raw = ?, raw_reasoning = ?, completion_tokens = ?, updated_at = ?
        WHERE session_id = ? AND request = ? AND state = 'running'`,
    ).run(clip(e.raw), clip(e.rawReasoning), e.completionTokens, at.ts, at.session, e.request);
  },
  model_call: (db, e, at) => {
    const state = e.error === undefined ? "done" : e.stopReason === "loop" || e.stopReason === "token_cap" || e.stopReason === "interrupted" ? "stopped" : "error";
    const values = [
      Math.round(e.ms),
      e.promptTokens ?? null,
      clipped(e.content),
      clipped(e.reasoning),
      e.toolCalls ?? null,
      clipped(e.error),
      state,
      at.ts,
      clipped(e.raw),
      clipped(e.rawReasoning),
      e.completionTokens ?? null,
      e.finishReason ?? null,
      e.stopReason ?? null,
      e.loop?.period ?? null,
      e.loop?.repeats ?? null,
    ];
    const updated =
      e.request === undefined
        ? 0
        : db
            .query(
              `UPDATE audit_model_calls
                  SET ms = ?, prompt_tokens = ?, content = ?, reasoning = ?, tool_calls = ?, error = ?,
                      state = ?, updated_at = ?, raw = ?, raw_reasoning = ?, completion_tokens = ?,
                      finish_reason = ?, stop_reason = ?, loop_period = ?, loop_repeats = ?
                WHERE session_id = ? AND request = ? AND state = 'running'`,
            )
            .run(...values, at.session, e.request).changes;
    if (updated > 0) return;
    db.query(
      `INSERT INTO audit_model_calls
         (session_id, turn_id, ts, purpose, model, request, ms, prompt_tokens, content, reasoning,
          tool_calls, error, state, updated_at, raw, raw_reasoning, completion_tokens,
          finish_reason, stop_reason, loop_period, loop_repeats)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(at.session, at.turn, at.ts, e.purpose, e.model, e.request ?? null, ...values);
  },
  tool_call: (db, e, at) => {
    index(db, at, "tool", e.result);
    db.query(
      `INSERT INTO audit_tool_calls
         (session_id, turn_id, ts, name, args, result, ok, ms, depth)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      at.session,
      at.turn,
      at.ts,
      e.name,
      clip(JSON.stringify(e.args) ?? "null"),
      clip(e.result),
      e.ok ? 1 : 0,
      Math.round(e.ms),
      e.depth,
    );
  },
  hook_run: (db, e, at) => event(db, at, "hook_run", e),
  compaction: (db, e, at) => event(db, at, "compaction", e),
  goal: (db, e, at) => event(db, at, "goal", e),
  event: (db, e, at) => event(db, at, e.name, e.payload),
};

/** Make text findable by `/audit search`. */
function index(db: Database, at: Place, kind: string, text: string): void {
  if (text === "") return;
  db.query(
    "INSERT INTO audit_fts (text, kind, session_id) VALUES (?, ?, ?)",
  ).run(clip(text), kind, at.session);
}

/** The free-form table: for the rare, low-volume things. */
function event(db: Database, at: Place, name: string, payload: unknown): void {
  db.query(
    "INSERT INTO audit_events (session_id, turn_id, ts, name, payload) VALUES (?, ?, ?, ?, ?)",
  ).run(
    at.session,
    at.turn,
    at.ts,
    name,
    clip(JSON.stringify(payload) ?? "null"),
  );
}
