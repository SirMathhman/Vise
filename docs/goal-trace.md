# The goal trace

When goal checking is on, Vise records every decision the goal machinery makes
while a conversation runs, and saves it with the conversation in the project's
`.vise/vise.db`. It answers "this session stopped although a goal was set: why?".
It holds what the page never shows: the hidden questions asked of the model and
its raw answers, the "continue" notes that push the model back to work, and the
one reason each turn's goal loop ended.

The trace is separate from the conversation. Loading a session returns the
messages exactly as saved; the trace is read back only so the conversation keeps
adding to it, and it is never shown to the model or replayed in the chat log.
Deleting a session deletes its trace. It is plain text like the audit log, so it
can contain whatever was in the conversation.

In Vise: `/goal log` prints the current conversation's trace, one block per
turn; `/goal log 3` shows the last three turns. (Questions and replies are
shortened there; the saved text is complete up to about 4000 characters each.)

## The table

`goal_trace` has one row per entry: `session_id`, `seq` (order), `at` (time),
`after` (how many messages the conversation had then, to place it in the
transcript), `kind`, and `data` (the whole entry as JSON).

| `kind`       | What it says                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `setting`    | goal checking was switched on or off                                                           |
| `turn_start` | a turn began: the user's line, whether goal checking was on, the goal carried in               |
| `ask`        | one hidden model call (each retry too): `purpose`, the exact `question`, the raw `reply` or the `failure` |
| `goal`       | the goal derived for the turn and when it is done; `fallback` = it is just the user's words    |
| `verdict`    | the goal check's answer: `yes`, `no`, `blocked` or `unknown`, with its detail                  |
| `progress`   | a mid-turn progress check; for `stuck`, whether the user chose to keep going                   |
| `continue`   | the note sent to push the model back to work, and the counters behind the decision             |
| `exit`       | **why the goal loop ended**, exactly one per turn, with the model's last reply                 |

## Why a turn ended (`exit.reason`)

| Reason                   | Meaning                                                                          |
| ------------------------ | -------------------------------------------------------------------------------- |
| `met`                    | the check said the goal is accomplished                                          |
| `blocked`                | the check said it needs the user (the detail says what)                          |
| `unknown`                | the goal check could not be made (the detail is the exact reason)                |
| `same-step`              | the check kept asking for the same step and nothing was done in between          |
| `max-continues-declined` | after many automatic continues the user was asked and said stop                  |
| `halted-progress`        | the mid-turn progress check found the work stuck and the user did not override it |
| `turn-failed`            | the turn itself failed (the detail is the error); no check was made              |
| `interrupted`            | the turn was stopped (Ctrl+C, stop button)                                       |
| `exception`              | something threw; the detail is the message                                       |
| `goal-off`               | goal checking was off for this turn                                              |
| `no-goal`                | no goal could be derived, so nothing was checked                                 |

`exit.lastReply` (the start of the model's last reply) and `exit.toolResults`
(tool results in the turn) are usually the clue when the model "just stopped".

## Example queries

```sql
-- Why did each turn of a session end?
select e.at, json_extract(e.data, '$.reason') as reason, json_extract(e.data, '$.detail') as detail
from goal_trace e
where e.session_id = :id and e.kind = 'exit' order by e.seq;

-- Turns that did not end with the goal met, newest first.
select s.name, e.at, json_extract(e.data, '$.reason') as reason, json_extract(e.data, '$.lastReply') as last_reply
from goal_trace e join sessions s on s.id = e.session_id
where e.kind = 'exit' and json_extract(e.data, '$.reason') <> 'met'
order by e.at desc limit 20;

-- The question and the raw answer behind each verdict of a session.
select a.at, json_extract(a.data, '$.question') as question, json_extract(a.data, '$.reply') as reply, json_extract(a.data, '$.failure') as failure
from goal_trace a
where a.session_id = :id and a.kind = 'ask' and json_extract(a.data, '$.purpose') = 'goal-check'
order by a.seq;

-- Every continue note that was sent (these never appear in the saved conversation).
select at, json_extract(data, '$.note') as note
from goal_trace where session_id = :id and kind = 'continue' order by seq;
```

The trace is rewritten with the session on every save (after each turn, before
each automatic continue, and when a turn throws), so a session that dies keeps
everything up to its last save. The global audit log (`docs/audit.md`) still
records the one-line goal events and the model-call timings.
