High value, low cost

1. Context-fill indicator — DONE. The bar under the chat shows a meter and "12.3k / 141.6k tokens · 9%" (`web/src/status/context-meter.ts`), red from 90%; per-call prompt progress bars show in the log.

2. Save / Resume sessions — DONE. Session menu (eight newest, with when each was saved) and Session → All sessions… (filter, resume, delete after asking, save under a name).

3. /context button — DONE. Clicking the context meter sends `/context`; also Agent → Show context usage.

High value, moderate cost 4. Compaction control — DONE. A "Compact" button appears in the context bar from 75% full; also Agent → Compact conversation.

5. Workflow runner — DONE. Agent → Run workflow… picks a workflow and an input and sends `/workflow <name> [input]`; a strip above the composer names it with Stop while it runs. (No per-step progress yet: the server does not report steps.)

6. Notes browser — DONE as the settings "Notes" tab, with editing.

Lower priority 7. Tool-call detail — DONE. A tool line opens (click, Enter or Space) to show its arguments and full result (clipped to 4000 characters each; `web/src/log/tool-details.ts`). Lines replayed from a saved session carry no details.

8. self info card — not done. The status pill shows the connection; model and profile are in the top bar.
