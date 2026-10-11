## Plan: browser_run_code for Firefox Extension

Enable `browser_run_code` in the Firefox extension backend by routing the snippet through `browser.tabs.executeScript` (MV2, synchronous) instead of the Chromium Playwright runner.

**Key constraint discovered:** Firefox MV2 `browser.tabs.executeScript(tabId, { code })` evaluates `code` as the body of a **synchronous** function. There is no `await` — the code must return a value directly, and any async work (fetch, XHR) must be done with callbacks or the code must be structured to return synchronously. The existing scripts in `extension/src/page-actions.ts` all follow this pattern (IIFE returning a plain object).

**Steps**

1. **Add a `runCode` op to the extension's ops record** — `extension/src/ops.ts`
   - Add a `runCode` entry to the `ops` record (around line 118, alongside `probe`, `snapshot`, etc.).
   - Handler: `({ tab, code }) => run(tab, code)` — reuses the existing `run<T>(tabId, code)` helper (line 94) which calls `browser.tabs.executeScript(tabId, { code })` and returns `results[0]`.
   - The code string is passed raw — no wrapping needed. The model's snippet is the function body.
   - `tab` is an integer (the tab number, already owned/granted — `requireOwned(tabId)` is called by the op dispatch, same as all other ops).
   - This is ~3 lines. No new permissions needed (`<all_urls>` and `tabs` are already in the manifest).

2. **Implement `ExtensionBackend.runCode()`** — `src/browser/extension.ts`
   - Replace the stub at lines 174–178 (`Promise.reject(new Error("browser_run_code is not supported..."))`) with:
   - `async runCode(id: number, code: string): Promise<string> { return this.tab("runCode", { tab: id, code }); }`
   - The `tab<T>` helper (line 87–92) already calls `this.link.call(op, params)` and returns the result.
   - **Result handling:** the extension's `background.ts` already JSON-serializes the whole `{ id, ok, result }` object (line 22–23), so the result arrives as a native value. The Chromium path truncates at 10,000 chars in the runner; the extension path needs equivalent truncation. Add a helper (or inline check) in `ExtensionBackend.runCode` that JSON-stringifies the result and truncates at 10,000 chars (same constant as `MAX_RESULT_CHARS` in `playwright-runner.mjs` line 11), matching Chromium behavior.

3. **Update the tool description** — `src/tools/defs/browser.ts` (lines 322–345)
   - The current description says "Run a Playwright snippet... with `page` (a Playwright Page) in scope" and "the snippet runs in a Node process with the full privileges of the user" — both Chromium-specific.
   - Since the description is shared across all backends (rendered into the system prompt via `src/client/tool-protocol.ts`), reword it to be backend-agnostic:
   - `description`: "Run JavaScript code against a browser tab. The code runs in the tab's context; `return` a value to get it back as JSON (truncated at 10,000 characters). Times out after 30 seconds. Disabled by default; the user enables it with /tool browser_run_code enable. Prefer the other browser tools for simple actions."
   - `code` parameter description: "JavaScript to run in the tab. Synchronous — no await (the code is the body of a sync function). For the Chromium backend, `page` (a Playwright Page) is available. For the Firefox extension, the page's JS context (DOM, window, fetch) is available. Return a value to get it back."
   - The WARNING about Node process privileges does not apply to the Firefox extension (the code runs in the page's origin, not a Node process). Remove or soften it.

4. **No changes needed to:**
   - `RISKY_TOOLS` in `src/wiring.ts` (stays disabled by default — user confirmed).
   - The handler in `src/tools/browser/browser.ts` (line 326–327) — it already calls `browser.runCode(id, ref(args, "code"))` which will now work for the extension backend.
   - `extension/manifest.json` — no new permissions needed.
   - `extension/src/background.ts` — the op dispatch already handles any op in the `ops` record; no changes needed.
   - The timeout: the existing `config.extensionCallTimeoutMs` (used by `ExtensionLink.call`) already bounds the round-trip; the Chromium 30-second timeout is set in `PlaywrightSession.run` (line 74–82 of `playwright.ts`). For the extension, the WebSocket call timeout is sufficient.

**Relevant files**

- `extension/src/ops.ts` — add `runCode` op to the `ops` record (~line 118); reuses `run<T>()` (line 94) and `requireOwned()`
- `src/browser/extension.ts` — replace `runCode` stub (lines 174–178) with `this.tab("runCode", { tab: id, code })`; add JSON.stringify + 10k truncation
- `src/tools/defs/browser.ts` — update `browser_run_code` description (lines 322–345) to be backend-agnostic
- `src/browser/chromium/playwright-runner.mjs` — reference only: `MAX_RESULT_CHARS = 10000` (line 11) is the truncation constant to match

**Verification**

1. **Type-check:** `bunx tsc --noEmit` (server/core) and `bun run typecheck:ext` (extension). Both must pass.
2. **Unit test for the extension op:** add a test that verifies the `runCode` op is registered in `ops` and that `ExtensionBackend.runCode` calls `link.call("runCode", { tab, code })` with the right arguments (mock `ExtensionLink`).
3. **Manual test:** with the Firefox extension loaded (`about:debugging` → Load Temporary Add-on), enable the tool (`/tool browser_run_code enable`), then call `browser_run_code` with a simple snippet like `document.title`. Verify the result comes back as a JSON string.
4. **Error case:** call `browser_run_code` with a snippet that throws (e.g., `throw new Error('test')`). Verify the model sees `error: cannot script this page (...)` (from the `run<T>` catch) or the appropriate error.
5. **Truncation:** call with a snippet that returns a large object (e.g., `JSON.stringify(document.querySelectorAll('*').length)` — small, but test with a snippet that builds a 20,000-char string). Verify it's truncated at 10,000 chars.
6. **Disabled by default:** verify that without `/tool browser_run_code enable`, calling the tool returns `error: tool browser_run_code is disabled`.

**Decisions**

- Code runs in the page's JS context (DOM, window, fetch) — no Playwright `page` object. User confirmed.
- Stays disabled by default (consistent with Chromium; user opts in via `/tool browser_run_code enable`). User confirmed.
- Result is JSON.stringify'd and truncated at 10,000 chars (same as Chromium). User confirmed.
- Synchronous code (no await) — inherent to Firefox MV2 `executeScript`. The description must reflect this.
- No per-backend description mechanism is added; the shared description is reworded to be backend-agnostic. (If a future need arises for fundamentally different descriptions per backend, a `perBackend` field on the `Tool` type could be added — out of scope here.)

**Further Considerations**

1. The Chromium description's WARNING about Node process privileges (file system, child processes) does not apply to the Firefox extension (the code runs in the page's origin). The reworded description should note this distinction or drop the WARNING entirely. Recommendation: drop the specific Node warning; the general "runs with full privileges" applies to both.
2. If the model writes `await` in a Firefox extension snippet, it will be a syntax error (or silently ignored in a sync function body). The description should make "synchronous — no await" prominent so the model adapts. If error rates are high, a future enhancement could pre-wrap the code in an async IIFE and `await` the result, but that's a separate change.
