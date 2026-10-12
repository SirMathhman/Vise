# The audit log

Vise records what the agent did in `~/.vise/audit.db` (SQLite; open it with
`sqlite3`, DB Browser, or `bun:sqlite`). Saved conversations are separate: they
live in each project's `.vise/vise.db`.

Settings: `VISE_AUDIT` (1 = on, 0 = off) and `VISE_AUDIT_RETENTION_DAYS`
(0 = keep forever). Tool arguments and results are stored as they were, so the
file can contain anything a tool saw, including secrets; keep it private.

In Vise: `/audit`, `/audit tools|models|errors|hooks`, `/audit search <text>`.

Hook runs have `phase` `pre`/`post` (turn hooks) or `pre_tool`/`post_tool` (tool hooks, which also carry `tool` and the hook's exit `status`; a `pre_tool` run with status 2 blocked the call).
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

## Model calls: the raw stream, and runaway calls

A model call is on record from the moment it starts (`state = 'running'`) and
the row is updated when it ends. While it runs, its raw text so far is written
every 30 seconds, so a call that hangs, or a program that dies, still leaves
what the model had written. `raw` is everything the call wrote **before** it
was parsed (tool calls included, which the chat never shows); `raw_reasoning`
is the end of its reasoning.

| Column (`audit_model_calls`)       | Meaning                                                              |
| ---------------------------------- | -------------------------------------------------------------------- |
| `request`                          | the client's number for the call (`/audit call <n>`)                 |
| `state`                            | `running`, `done`, `stopped`, `error`, `abandoned` (the program died) |
| `stop_reason`                      | `loop`, `token_cap`, `interrupted`, `error` when it was cut short    |
| `completion_tokens`, `finish_reason` | what the server counted and why it ended the call                  |
| `loop_period`, `loop_repeats`      | what repeated at the end of the call, if anything                    |

Vise stops a call itself when it repeats the same text (`VISE_LOOP_GUARD`) or
writes more than `VISE_MAX_CALL_TOKENS` tokens (0 = no limit). The turn then
ends with "stopped a runaway model call" and the goal is kept, except that
a call stopped for repeating itself is asked again up to `VISE_LOOP_RETRIES`
times (default 1) with a repeat penalty (llama.cpp's DRY sampler); both
attempts are recorded, the first with `stop_reason = loop`.

In Vise: `/audit calls [n]` lists the latest calls (running ones first) and
`/audit call <n>` prints one with its raw text. In the web page, click the
"Writing…" line or choose Agent → Inspect model output… for a live view.

```sql
-- Calls Vise had to stop
SELECT ts, purpose, stop_reason, completion_tokens, loop_period, loop_repeats
FROM audit_model_calls WHERE state = 'stopped' AND stop_reason IN ('loop', 'token_cap');

-- The longest completions, with the end of what they wrote
SELECT request, purpose, completion_tokens, substr(raw, -300) AS tail
FROM audit_model_calls ORDER BY completion_tokens DESC LIMIT 10;

-- Calls that never finished
SELECT session_id, request, purpose, started_at, updated_at
FROM audit_model_calls WHERE state IN ('running', 'abandoned');
```
