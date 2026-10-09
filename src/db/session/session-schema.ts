import type { Migration } from "../migrate.ts";

/** Schema of the per-project `<root>/.vise/vise.db` (saved conversations). */
export const SESSION_MIGRATIONS: Migration[] = [
  `
  CREATE TABLE sessions (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    active_profile TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE TABLE messages (
    session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq            INTEGER NOT NULL,
    role           TEXT NOT NULL,
    content        TEXT NOT NULL,
    typed          INTEGER,
    tool_calls     TEXT,
    tool_call_id   TEXT,
    images         TEXT,
    PRIMARY KEY (session_id, seq)
  );
  CREATE INDEX sessions_updated ON sessions(updated_at);
  CREATE VIRTUAL TABLE message_fts USING fts5(content, session_id UNINDEXED);
  `,
  // The agent's todo list, as JSON.
  `ALTER TABLE sessions ADD COLUMN todos TEXT`,
  // The goal trace (see src/core/goal-trace.ts): every goal decision, in order, with its
  // evidence. data is the entry as JSON; after is the message count when it happened.
  `CREATE TABLE goal_trace (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    seq        INTEGER NOT NULL,
    at         TEXT NOT NULL,
    after      INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    data       TEXT NOT NULL,
    PRIMARY KEY (session_id, seq)
  )`,
];
