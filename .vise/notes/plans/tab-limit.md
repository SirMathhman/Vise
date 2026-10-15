## Plan: Tab Limit for Firefox Extension

Enforce a configurable maximum number of tabs the extension can control at once (default 5). When the limit is reached, new tabs are refused to the agent with a clear error, and auto-granted tabs (from `target=_blank` / `window.open`) are queued and promoted when a slot frees up. A new `browser_close_tab` tool lets the agent release a tab.

**Steps**

### Phase 1 — Config plumbing (server → extension)

1. **Add `tabLimit` to `SPEC` in `src/config.ts`** — key `VISE_TAB_LIMIT`, default 5. Follow the existing pattern: a string key, a number, a default, no restart required.

2. **Send config on connect from `ExtensionHub.attach()`** (`src/web/ext/ext-hub.ts`, line 47) — immediately after `this.socket = socket`, send `JSON.stringify({ config: { tabLimit: config.tabLimit } })`. This runs once per (re)connect, so reconnecting self-heals a stale value.

3. **Handle the `config` message in `extension/src/background.ts`** — extend `handle()` (line 26) with an early branch: if the parsed message has a `config` field, store `config.tabLimit` in `browser.storage.local` under key `"tabLimit"` and return (do not respond with `{id, ok}`). Place this check before the `op` lookup so it doesn't fall through to the ops dispatch. Add a `getTabLimit()` function (default 5) following the `getPort()` pattern in `extension/src/config.ts`.

4. **Add `tabLimit` to `.env.example`**.

### Phase 2 — Extension-side enforcement (`extension/src/tabs.ts`)

5. **Add a `pending` queue** — an array of `{ tabId, title, url }` (or minimal tab info) that holds auto-granted tabs waiting for a slot.

6. **Modify `grant(tabId)` to enforce the limit** — split into two functions:
   - `tryGrant(tabId, opts?)` → returns `{ ok: true }` or `{ ok: false, reason: "limit" }`. Checks `owned.size >= tabLimit`. If full, returns failure.
   - `enqueue(tabId, info)` — pushes onto `pending` (for auto-granted tabs only). Cap the queue at, say, 3 items (discard the oldest if exceeded) so it doesn't grow unbounded.
   - The existing `grant()` can remain as a thin wrapper that calls `tryGrant()` and ignores the result (for internal callers that don't care about the result, like the auto-grant path).

7. **Update the auto-grant listener** (`extension/src/tabs.ts` line 55, `onCreated`) — instead of calling `grant()` unconditionally, call `tryGrant()`. If it fails with `"limit"`, call `enqueue(tab.id, tab)`.

8. **Update `release(tabId)`** — after removing from `owned`, check `pending`. If non-empty, shift the next item out, call `grant(tabId)` on it, and send `{ event: "shared", tab: { id, title, url } }` over the WebSocket (same shape as a user-shared tab). This promotes the queued tab and notifies the agent.

9. **Update `extension/src/ops.ts` `openTab`** (line 119) — after creating the tab, call `tryGrant(tab.id)` instead of `grant(tab.id)`. If it fails, close the tab that was just created (`browser.tabs.remove(tab.id)`) and re-throw with a message like `"tab limit reached (5), release a tab first"`. The server's `ExtensionBackend` propagates this error to the agent as a tool error.

10. **Update `extension/src/background.ts` `give()`** (line 159) — call `tryGrant()` instead of `grant()`. If it fails, return an error response to the sidebar (the sidebar shows a notice: "Tab limit reached. Release a tab first.").

### Phase 3 — Agent-facing tool: `browser_close_tab`

11. **Add tool definition** in `src/tools/defs/browser.ts` — `browser_close_tab` with a required `tab` (integer) parameter, description: "Close a tab the agent is controlling. Frees its slot; a queued tab (if any) is promoted." Category: `browser`. Follow the existing pattern (name, description, parameters, `display`).

12. **Add handler** in `src/tools/browser/browser.ts` — look up the tab, call `browser.closeTab(id)` (already on the `BrowserBackend` interface, line 96 of `src/browser/types.ts`). Return a confirmation string like `"tab N closed"`.

13. **Register in `baseHandlers`** in `src/tools.ts`.

### Phase 4 — Sidebar UI

14. **Show limit status in `extension/src/sidebar.ts`** — in the `checks()` function (line 142), change the shared-tabs count to show `"Shared tabs 3/5"` when below the limit, and `"Shared tabs 5/5 (max)"` when at the limit. Use `getTabLimit()` from `config.ts`.

15. **Show pending queue** — if `pending` is non-empty, show a line like `"1 tab waiting"` below the list. This requires the `status()` function in `background.ts` to include `pending` count and items. Add a `pending` field to the status object.

16. **Disable "Give Vise this tab" button at limit** — in `sidebar.ts`, when the count equals the limit, disable the `#give` button and show a tooltip explaining why. (Optional refinement; the error response from step 10 already handles it gracefully.)

### Phase 5 — Notification on promotion

17. **Promotion sends `shared` event** — covered in step 8. When `release()` promotes a queued tab, the `shared` event flows through `ExtensionHub` → `onUserShare` → `Session.notify` → the agent gets a notice at the start of its next turn: `[automatic notice: a browser tab became available: tab N, "Title", url]`. This reuses the existing `describeShare()` path in `src/browser/extension.ts` (line 49).

**Dependencies**

- Phase 1 blocks Phase 2 (the extension needs the limit value before enforcing).
- Phase 3 is independent of Phase 2 (the tool works regardless of the limit — it just calls `closeTab`).
- Phase 4 is independent (reads the limit from storage; the limit is 5 by default even before the server pushes a value).
- Phase 5 is part of Phase 2 (step 8).
- Phases 2 and 3 can run in parallel.

**Relevant files**

- `src/config.ts` — add `tabLimit` to `SPEC` (default 5)
- `src/web/ext/ext-hub.ts` — `attach()` line 47: send config on connect
- `extension/src/background.ts` — `handle()` line 26: receive config; `give()` line 159: use `tryGrant`; `status()` line 100: include pending
- `extension/src/tabs.ts` — add `pending` queue, `tryGrant`, `enqueue`, modify `grant`, `release`, `onCreated` listener
- `extension/src/config.ts` — add `getTabLimit()` (key `"tabLimit"`, default 5)
- `extension/src/ops.ts` — `openTab` line 119: use `tryGrant`, close tab on failure
- `extension/src/sidebar.ts` — `checks()` line 142: show limit; pending queue display
- `extension/sidebar.html` — minor: queue display element
- `src/tools/defs/browser.ts` — add `browser_close_tab` definition
- `src/tools/browser/browser.ts` — add `browser_close_tab` handler
- `src/tools.ts` — register handler in `baseHandlers`
- `.env.example` — add `VISE_TAB_LIMIT`
- `src/browser/types.ts` — `closeTab` already exists (line 96); no change needed

**Verification**

1. **Unit test: `tryGrant` limit** — in a new or existing test file, verify that `tryGrant` succeeds when `owned.size < limit` and fails at `limit`. Verify that `release` promotes from `pending`.
2. **Integration: server sends config** — verify that `ExtensionHub.attach()` sends the config message (check in `test/web/ext-hub.test.ts` or similar).
3. **Manual: agent opens tabs to the limit** — with the extension loaded, have the agent open 5 tabs (default limit). The 6th `browser_open` should fail with `"tab limit reached"`.
4. **Manual: auto-grant queue** — with 5 tabs open, navigate to a page with a `target=_blank` link. Click it. The new tab opens in Firefox but is not owned. Close one of the 5 tabs via `browser_close_tab`. The queued tab should be promoted and the agent should get a notice.
5. **Manual: user shares at limit** — with 5 tabs open, click "Give Vise this tab" in the sidebar. It should show an error/notice.
6. **Manual: `browser_close_tab`** — agent calls it with a valid tab id. The tab closes in Firefox and is removed from the owned list.
7. **Type-check:** `bunx tsc --noEmit` and `bun run typecheck:ext`.

**Decisions**

- Default limit: 5 tabs (configurable via `VISE_TAB_LIMIT` in `~/.vise/.env`, pushed to the extension on connect).
- All tabs count equally toward one limit (agent-opened, user-shared, auto-granted).
- At limit: agent-opened tabs are refused with an error; user-shared tabs are refused with a sidebar message; auto-granted tabs are queued.
- Queue capacity: 3 items max (discard oldest on overflow) to prevent unbounded growth.
- On promotion: queued tab is granted and a `shared` event is sent so the agent gets a proper notice.
- `browser_close_tab` closes the tab in Firefox AND releases it (both actions).
- The limit is not sandboxed per-window or per-origin — it's a global limit on all tabs the extension controls.
- No changes to the Chromium or Firefox backends (this is an extension-only concern; the headless browsers don't have the same tab-proliferation problem).

**Scope exclusions**

- No per-tab memory tracking or resource accounting.
- No LRU eviction (tabs are only freed by explicit close or release, not by age).
- No changes to `TabWatcher` in `src/tools/browser/tab-watch.ts` (it still compares before/after; a queued tab simply won't appear in the after-list).
- No persistence of the queue across extension restarts (in-memory only, like the owned set).
- No changes to the server-side `noTabsHint` or `describeShare` logic.
