import type { Database } from "bun:sqlite";
import type { Message } from "@vise/core";
import type { GoalTraceEntry } from "@vise/core";
import type { TodoItem } from "@vise/core";

/**
 * Write (or overwrite) one session and all its messages in a single
 * transaction, so a crash can never leave a torn snapshot. `savedAt` is the
 * time to record as the last save (the import keeps the original file's).
 */
export function writeSession(
  db: Database,
  id: string,
  name: string,
  messages: Message[],
  activeProfile: string | undefined,
  savedAt: string = new Date().toISOString(),
  todos: TodoItem[] = [],
  trace: GoalTraceEntry[] = [],
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO sessions (id, name, active_profile, created_at, updated_at, todos)
       VALUES (?1, ?2, ?3, ?4, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET
         name = ?2, active_profile = ?3, updated_at = ?4, todos = ?5`,
    ).run(id, name, activeProfile ?? null, savedAt, JSON.stringify(todos));
    db.query("DELETE FROM messages WHERE session_id = ?").run(id);
    db.query("DELETE FROM message_fts WHERE session_id = ?").run(id);
    const insert = db.query(
      `INSERT INTO messages
         (session_id, seq, role, content, typed, tool_calls, tool_call_id, images)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const index = db.query(
      "INSERT INTO message_fts (content, session_id) VALUES (?, ?)",
    );
    db.query("DELETE FROM goal_trace WHERE session_id = ?").run(id);
    const insertTrace = db.query(
      `INSERT INTO goal_trace (session_id, seq, at, after, kind, data)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    trace.forEach((entry, seq) => {
      insertTrace.run(
        id,
        seq,
        entry.at,
        entry.after,
        entry.kind,
        JSON.stringify(entry),
      );
    });
    messages.forEach((m, seq) => {
      insert.run(
        id,
        seq,
        m.role,
        m.content,
        m.typed === undefined ? null : m.typed ? 1 : 0,
        m.tool_calls ? JSON.stringify(m.tool_calls) : null,
        m.tool_call_id ?? null,
        m.images ? JSON.stringify(m.images) : null,
      );
      if (m.content !== "") index.run(m.content, id);
    });
  })();
}

interface MessageRow {
  role: Message["role"];
  content: string;
  typed: number | null;
  tool_calls: string | null;
  tool_call_id: string | null;
  images: string | null;
}

/** The messages of a session, in order. */
export function readMessages(db: Database, id: string): Message[] {
  const rows = db
    .query(
      `SELECT role, content, typed, tool_calls, tool_call_id, images
       FROM messages WHERE session_id = ? ORDER BY seq`,
    )
    .all(id) as MessageRow[];
  return rows.map((r) => {
    const m: Message = { role: r.role, content: r.content };
    if (r.typed !== null) m.typed = r.typed === 1;
    if (r.tool_calls !== null) m.tool_calls = JSON.parse(r.tool_calls);
    if (r.tool_call_id !== null) m.tool_call_id = r.tool_call_id;
    if (r.images !== null) m.images = JSON.parse(r.images);
    return m;
  });
}

/** The goal trace of a session, in order. Entries that cannot be read are skipped. */
export function readTrace(db: Database, id: string): GoalTraceEntry[] {
  const rows = db
    .query("SELECT data FROM goal_trace WHERE session_id = ? ORDER BY seq")
    .all(id) as { data: string }[];
  const entries: GoalTraceEntry[] = [];
  for (const row of rows) {
    try {
      entries.push(JSON.parse(row.data) as GoalTraceEntry);
    } catch {
      // A damaged entry must not stop the rest of the trace from being read.
    }
  }
  return entries;
}
