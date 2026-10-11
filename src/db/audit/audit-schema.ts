import type { Migration } from "../migrate.ts";

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
  `
  ALTER TABLE audit_messages ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE audit_model_calls (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL,
    turn_id       TEXT,
    ts            TEXT NOT NULL,
    purpose       TEXT NOT NULL,
    model         TEXT NOT NULL,
    ms            INTEGER NOT NULL,
    prompt_tokens INTEGER,
    content       TEXT,
    reasoning     TEXT,
    tool_calls    INTEGER,
    error         TEXT
  );
  CREATE TABLE audit_tool_calls (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    turn_id    TEXT,
    ts         TEXT NOT NULL,
    name       TEXT NOT NULL,
    args       TEXT,
    result     TEXT NOT NULL,
    ok         INTEGER NOT NULL,
    ms         INTEGER NOT NULL,
    depth      INTEGER NOT NULL
  );
  CREATE INDEX audit_model_calls_session ON audit_model_calls(session_id, id);
  CREATE INDEX audit_tool_calls_session ON audit_tool_calls(session_id, id);
  CREATE INDEX audit_tool_calls_name ON audit_tool_calls(name, ok);
  `,
  `
  CREATE INDEX audit_turns_time ON audit_turns(started_at);
  CREATE INDEX audit_messages_ts ON audit_messages(ts);
  CREATE INDEX audit_messages_turn ON audit_messages(turn_id);
  CREATE INDEX audit_model_calls_ts ON audit_model_calls(ts);
  CREATE INDEX audit_model_calls_turn ON audit_model_calls(turn_id);
  CREATE INDEX audit_tool_calls_ts ON audit_tool_calls(ts);
  CREATE INDEX audit_tool_calls_turn ON audit_tool_calls(turn_id);
  CREATE INDEX audit_events_ts ON audit_events(ts);
  CREATE VIRTUAL TABLE audit_fts USING fts5(text, kind UNINDEXED, session_id UNINDEXED);
  `,
  // A model call is recorded when it starts and updated as it runs, with the raw stream and why it ended.
  `
  ALTER TABLE audit_model_calls ADD COLUMN request INTEGER;
  ALTER TABLE audit_model_calls ADD COLUMN state TEXT NOT NULL DEFAULT 'done';
  ALTER TABLE audit_model_calls ADD COLUMN started_at TEXT;
  ALTER TABLE audit_model_calls ADD COLUMN updated_at TEXT;
  ALTER TABLE audit_model_calls ADD COLUMN raw TEXT;
  ALTER TABLE audit_model_calls ADD COLUMN raw_reasoning TEXT;
  ALTER TABLE audit_model_calls ADD COLUMN completion_tokens INTEGER;
  ALTER TABLE audit_model_calls ADD COLUMN finish_reason TEXT;
  ALTER TABLE audit_model_calls ADD COLUMN stop_reason TEXT;
  ALTER TABLE audit_model_calls ADD COLUMN loop_period INTEGER;
  ALTER TABLE audit_model_calls ADD COLUMN loop_repeats INTEGER;
  CREATE INDEX audit_model_calls_request ON audit_model_calls(session_id, request);
  CREATE INDEX audit_model_calls_state ON audit_model_calls(state);
  `,
];
