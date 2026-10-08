import type { Migration } from "./migrate.ts";

/**
 * Schema of the global audit database `~/.vise/audit.db`: an append-only
 * record of everything the agent did, across every project. Tables are only
 * ever added to; a step that changes one is a new entry at the end.
 */
export const AUDIT_MIGRATIONS: Migration[] = [
  `
  CREATE TABLE audit_sessions (
    id               TEXT PRIMARY KEY,
    root             TEXT NOT NULL,
    saved_session_id TEXT,
    started_at       TEXT NOT NULL,
    ended_at         TEXT
  );
  CREATE TABLE audit_turns (
    id         TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    user_text  TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    outcome    TEXT,
    error      TEXT
  );
  CREATE TABLE audit_messages (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   TEXT NOT NULL,
    turn_id      TEXT,
    ts           TEXT NOT NULL,
    role         TEXT NOT NULL,
    content      TEXT NOT NULL,
    typed        INTEGER,
    tool_calls   TEXT,
    tool_call_id TEXT,
    images       TEXT
  );
  CREATE TABLE audit_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id    TEXT,
    ts         TEXT NOT NULL,
    name       TEXT NOT NULL,
    payload    TEXT
  );
  CREATE INDEX audit_sessions_root ON audit_sessions(root, started_at);
  CREATE INDEX audit_turns_session ON audit_turns(session_id);
  CREATE INDEX audit_messages_session ON audit_messages(session_id, id);
  CREATE INDEX audit_events_session ON audit_events(session_id, id);
  CREATE INDEX audit_events_name ON audit_events(name);
  `,
];
