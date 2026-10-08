import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AuditEvent, AuditSink } from "../core/audit.ts";
import { globalDataDir } from "../data-dir.ts";
import { AUDIT_MIGRATIONS } from "./audit-schema.ts";
import { openDb, tryDb } from "./open.ts";

/** Longest wait before queued events are written. */
const FLUSH_MS = 250;

/**
 * The audit log in `~/.vise/audit.db`. `record` only queues the event; the
 * queue is written in one transaction a moment later, when a turn or
 * conversation ends, or on `close`, so recording never slows a turn. Never
 * throws: a write that fails is reported once on stderr and its events are
 * dropped (an audit failure must not break the agent).
 */
export class SqliteAuditSink implements AuditSink {
  private queue: { event: AuditEvent; ts: string }[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private warned = false;
  private readonly path: string;

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
            for (const q of batch) this.write(opened.value, q.event, q.ts);
          })(),
        )
      : opened;
    if (!written.ok && !this.warned) {
      this.warned = true;
      console.error(
        `vise: audit log not written (${JSON.stringify(written.error)})`,
      );
    }
  }

  /** Flush and stop (the session is closing). */
  close(): void {
    this.flush();
  }

  private write(db: Database, e: AuditEvent, ts: string): void {
    switch (e.kind) {
      case "session_start":
        db.query(
          "INSERT OR IGNORE INTO audit_sessions (id, root, started_at) VALUES (?, ?, ?)",
        ).run(e.session, this.root, ts);
        break;
      case "session_end":
        db.query("UPDATE audit_sessions SET ended_at = ? WHERE id = ?").run(
          ts,
          e.session,
        );
        break;
      case "link":
        db.query(
          "UPDATE audit_sessions SET saved_session_id = ? WHERE id = ?",
        ).run(e.saved, e.session);
        break;
      case "turn_start":
        db.query(
          "INSERT INTO audit_turns (id, session_id, user_text, started_at) VALUES (?, ?, ?, ?)",
        ).run(e.turn, e.session, e.text, ts);
        break;
      case "turn_end":
        db.query(
          "UPDATE audit_turns SET ended_at = ?, outcome = ?, error = ? WHERE id = ?",
        ).run(ts, e.outcome, e.error ?? null, e.turn);
        break;
      case "message": {
        const m = e.message;
        db.query(
          `INSERT INTO audit_messages
             (session_id, turn_id, ts, role, content, typed, tool_calls, tool_call_id, images)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          e.session,
          e.turn ?? null,
          ts,
          m.role,
          m.content,
          m.typed === undefined ? null : m.typed ? 1 : 0,
          m.tool_calls ? JSON.stringify(m.tool_calls) : null,
          m.tool_call_id ?? null,
          m.images ? JSON.stringify(m.images) : null,
        );
        break;
      }
      case "event":
        db.query(
          "INSERT INTO audit_events (session_id, turn_id, ts, name, payload) VALUES (?, ?, ?, ?, ?)",
        ).run(e.session, e.turn ?? null, ts, e.name, JSON.stringify(e.payload));
        break;
    }
  }
}
