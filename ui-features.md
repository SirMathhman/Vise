High value, low cost

1. Context-fill indicator — the progress event already flows through server.ts ({ total, cache, processed, time_ms }) but is dropped in the case "progress" handler. A small footer/meter showing prompt: N / M tokens (and cache hits) would make the auto-compact behavior (COMPACTION_THRESHOLD = 0.9) and when compaction is about to fire visible. The data is already on the wire — this is mostly rendering.

2. Save / Resume sessions — DONE. Toggleable sessions panel in the web UI: lists saved sessions (populated from `/resume` on load), resume by clicking a row (clears the chat log), save the current conversation via a freeform name input. Follows the same toggle-panel pattern as the tools panel. No server changes needed.

3. /context button — reportContext is a pure read (no model call). A one-click "context" button that pops the current fill as a system line, or anchors the indicator above, is trivial and pairs with #1.

High value, moderate cost 4. Compaction control — /compact is a manual command; exposing a button (and possibly the RECENT_TURNS_TO_KEEP state) makes the compaction mechanic user-driven rather than model-driven.

5. Workflow runner — /workflow <name> [input] is a full surface with WorkflowSource and project/global scoping. A dropdown (like profile/tools) + a small input field would let web users run instruction and tool workflows without typing the command.

6. Notes browser — /note, /note init <name> mirror the tools panel pattern exactly. A read/list UI for the .vise/notes/ store (names + summaries) would round out the header.

Lower priority 7. Tool-call detail — case "tool" currently renders a flat tool: <name> line. Expanding each into a collapsible block showing arguments + result (the result messages already carry tool results) would make the agent's work inspectable, but it's a larger UI change (per-message structure, not a dropdown).

8. self info card — the self tool reports backend, model, cwd, context fill, active profile, and hook commands. A static "about" popover from the header would expose all of that without a model call, but it overlaps with what #1/#2 already surface.
