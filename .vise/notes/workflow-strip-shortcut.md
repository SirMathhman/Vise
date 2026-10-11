## Plan: Workflow Strip Appears for Shortcut Invocations

**TL;DR** — When a workflow is invoked via a shortcut (e.g. `/commit` instead of `/workflow commit`), the status strip above the composer does not appear immediately because `running(line)` only regex-matches the explicit `/workflow <name>` form. Fix: also check the cached workflow list for a bare command name match.

**Steps**

1. **Modify `running(line)` in `web/src/menubar/workflow-picker.ts` (lines 156–160)**
   - Current logic: regex `/^\/workflow\s+(\S+)/` against the line. If no match, `name` is `undefined` → `showStrip(null)` hides the strip.
   - New logic: if the regex doesn't match, extract the first token after the leading `/` (e.g. `/commit` → `commit`) and check `workflows.some(w => w.name === token)`. If it matches a known workflow, show the strip with that name. Only call `showStrip(null)` when nothing matches (preserving current hide-on-non-workflow behavior).
   - The `workflows` array (line 87, `WorkflowEntry[]` with `.name`) is already in closure scope and accessible from `running`.
   - Edge case: if `line` is `null` (turn finished), still hide the strip — that path is handled by `running(null)` in `app.ts:155` and must remain `showStrip(null)`.
   - Edge case: `/workflow init <name>` → the current code already handles `name === "init"` → hide. Preserve that.
   - Edge case: a shortcut that is NOT a workflow (e.g. `/foo` where no workflow named `foo` exists) → no match → `showStrip(null)` (strip stays hidden, same as today).

**Relevant files**

- `web/src/menubar/workflow-picker.ts` — the only file to modify. `running(line)` at line 156–160, `showStrip` at line 91–99, `workflows` cache at line 87, `WorkflowEntry` type at lines 1–4.
- `web/src/app.ts` — call sites (read-only): `running(body)` at line 195 (before send), `running(null)` at line 155 (turn finished), `observe(message)` at line 412. No changes needed here.
- `src/repl/commands/shortcut-command.ts` — server-side shortcut resolution (read-only context: confirms `/commit` → `/workflow commit` rewrite happens server-side, so the client never sees the resolved form).

**Verification**

1. **Manual — direct invocation:** Start the web UI (`bun run dev:web`), open a folder with a saved workflow (e.g. `commit`), type `/workflow commit` and press Enter. The strip should appear immediately showing "Running workflow commit…". (Already works; confirm no regression.)
2. **Manual — shortcut invocation:** With the same setup, type `/commit` (the shortcut for the workflow). The strip should appear immediately showing "Running workflow commit…" — no visible gap.
3. **Manual — non-workflow command:** Type a non-workflow command (e.g. `/help` or any free text). The strip should remain hidden.
4. **Manual — `/workflow init`:** Type `/workflow init test`. The strip should remain hidden (the `name === "init"` guard).
5. **Manual — unknown shortcut:** Type `/nonexistent` (no workflow by that name). The strip should remain hidden.
6. **Type-check:** `bun run typecheck:web` passes.

**Decisions**

- Check the cached `workflows` list (already available in closure scope) rather than doing a server round-trip — zero latency, no new message type needed.
- The `workflows` cache is populated by `observe` when a `type: "workflows"` message arrives (triggered by opening the Run workflow… dialog). If the cache is empty (user never opened the dialog), the shortcut check simply finds no match and falls through to `showStrip(null)` — the strip still appears via the server's `start` event a few ms later. This is a safe degradation, not a regression.
- No changes to `followRun`, `showStrip`, `observe`, `app.ts`, or any server-side file.
- Scope: only the `running(line)` function body changes. One file, ~5 lines of logic.

**Further Considerations**

1. If the `workflows` cache is stale (a workflow was deleted or renamed since the last `workflows_list`), the strip might briefly show an outdated name before the server's `start` event corrects it. This is the same as today's direct `/workflow <name>` behavior (which also trusts the user's input without validation). Not worth fixing in this change.
2. The `workflows` list could be proactively refreshed on page load (in addition to when the dialog opens) so the cache is warm from the start. That would be a small follow-up if the gap becomes noticeable, but it's not needed for the fix itself.
