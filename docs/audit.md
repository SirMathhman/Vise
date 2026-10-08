# The audit log

Vise records what the agent did in `~/.vise/audit.db` (SQLite; open it with
`sqlite3`, DB Browser, or `bun:sqlite`). Saved conversations are separate: they
live in each project's `.vise/vise.db`.

Settings: `VISE_AUDIT` (1 = on, 0 = off) and `VISE_AUDIT_RETENTION_DAYS`
(0 = keep forever). Tool arguments and results are stored as they were, so the
file can contain anything a tool saw, including secrets; keep it private.

In Vise: `/audit`, `/audit tools|models|errors|hooks`, `/audit search <text>`.
From a shell: `vise-cli --audit-export <conversation id> > run.json` (an id
prefix is enough; ids are in `audit_sessions`).

## Tables

| Table               | One row per                                                                |
| ------------------- | -------------------------------------------------------------------------- |
| `audit_sessions`    | conversation (`root`, `saved_session_id` = the id `/resume` takes)         |
| `audit_turns`       | user message (`user_text`, `outcome` ok/failed/interrupted, `error`)       |
| `audit_messages`    | message in the conversation, subagents' too (`depth` > 0)                  |
| `audit_model_calls` | call to the model (`purpose`, `ms`, `prompt_tokens`, reply, `error`)       |
| `audit_tool_calls`  | tool call (`args`, whole `result`, `ok`, `ms`, `depth`)                    |
| `audit_events`      | command, hook run, compaction, goal event (`name`, JSON `payload`)         |
| `audit_fts`         | full-text index of messages and tool results                               |

## Example queries

```sql
-- Slowest tools and how often they fail
SELECT name, COUNT(*) calls, SUM(ok = 0) failed, ROUND(AVG(ms)) avg_ms
FROM audit_tool_calls GROUP BY name ORDER BY avg_ms DESC;

-- Everything one turn did, in order
SELECT 'tool' kind, ts, name detail FROM audit_tool_calls WHERE turn_id = :turn
UNION ALL SELECT 'model', ts, purpose FROM audit_model_calls WHERE turn_id = :turn
ORDER BY ts;

-- Failed turns in the last week
SELECT s.root, t.started_at, t.user_text, t.error
FROM audit_turns t JOIN audit_sessions s ON s.id = t.session_id
WHERE t.outcome != 'ok' AND t.started_at > datetime('now', '-7 days');

-- Where did the context go? (largest prompts)
SELECT session_id, purpose, prompt_tokens FROM audit_model_calls
ORDER BY prompt_tokens DESC LIMIT 10;

-- What did compaction throw away?
SELECT ts, json_extract(payload, '$.summarized') n, json_extract(payload, '$.summary') summary
FROM audit_events WHERE name = 'compaction';

-- Find a phrase anywhere
SELECT kind, session_id, snippet(audit_fts, 0, '[', ']', '...', 12)
FROM audit_fts WHERE audit_fts MATCH '"connection refused"';
```
