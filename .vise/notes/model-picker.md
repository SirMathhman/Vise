## Plan: OpenRouter Model Picker

Replace the plain `<select id="model">` in the app bar with a searchable combobox panel that shows human-readable names, context-length and vision badges, and a "recently used" section. Works for both OpenRouter (hundreds of models) and local llama.cpp (few models, same UI, just less data).

**Why:** OpenRouter has 200+ models but the current `<select>` caps at 40 raw IDs with no search. Users need to find a model by name, see its capabilities at a glance, and jump back to a recent model quickly.

**Steps**

### Phase 1: Server — structured model list API

1. **Extend `LlmClient` to return rich model data**
   - In `src/client/llm.ts`: extend the `ModelsResponse` interface (line 40) from `{ data?: { id: string }[] }` to include `name`, `context_length`, `architecture.input_modalities`. Add a new method `listModelDetails(): Promise<Result<ModelDetail[]>>` that fetches `provider.modelsUrl` and returns the full objects.
   - Define `ModelDetail` type: `{ id: string; name?: string; contextLength?: number; vision?: boolean }` — put it in `src/client/model-queries.ts` or a new `src/client/model-types.ts`.
   - For local llama.cpp (`/v1/models`), the response only has `id` (no name/context/vision) — return entries with `name: undefined`. The picker handles that gracefully.
   - Keep the existing `listModels(): Promise<Result<string[]>>` unchanged — it's used by `ModelController` for the `/model` command and the composer autocomplete.
   - **Parallel with step 2**

2. **New WebSocket API handler: `model_list` + `model_set`**
   - Create `src/web/api/model-api.ts`.
   - Handle `model_list` → returns `{ models: ModelDetail[], active: string }` by calling the new `LlmClient.listModelDetails()` and `LlmClient.getModel()`.
   - Handle `model_set` → calls `LlmClient.setModel(id)` and returns `{ ok: true }`. This avoids queuing behind a running turn (same pattern as `mcp-api.ts`, `notes-api.ts`).
   - Register both messages in `src/web/server.ts` alongside the other API handlers (never queued behind a turn).
   - **Depends on 1**

### Phase 2: Web UI — combobox HTML + CSS

3. **Replace `<select>` with button + panel in HTML**
   - In `web/index.html`: replace `<select id="model" class="field appbar-select">` with:
     - `<button id="model-btn" class="field appbar-select" aria-haspopup="listbox" aria-expanded="false">Loading…</button>` — shows the active model's name, ellipsized, same visual footprint as the old `<select>`.
     - `<div id="model-panel" class="dropdown model-panel hidden" role="listbox" aria-label="Model">` containing:
       - `<div class="dropdown-head"><input id="model-search" class="field" type="search" placeholder="Search models…"></div>`
       - `<div id="model-recent" class="model-section"></div>` — "Recently used" section (hidden when empty or when searching)
       - `<ul id="model-list" class="list"></ul>` — the full model list
       - `<p class="hint dropdown-foot">Enter to select · Esc to close</p>`
   - Remove the old `populateModelSelect` function (or repurpose it for local-only fallback).
   - **Parallel with step 4**

4. **CSS for the model panel**
   - In `web/styles/topbar.css` (or a new `web/styles/model-panel.css`): add `.model-panel` class.
   - Override `.dropdown`'s `right: var(--sp-3)` to anchor near the model button: use `right: auto; left: 0` or compute offset from the button's position. The panel is wider than the button (min-width ~24rem to show name + ID + badges).
   - Style `.model-item` (each row): flex row with `.model-name` (primary, bold when active), `.model-id` (small, dim, truncated), `.model-meta` (right-aligned: context badge like "200k" + vision icon "👁"). Reuse `.list-item` base style with `[aria-current="true"]` for the active model.
   - Style `.model-section` for the recents header (small caps dim label).
   - Use existing tokens: `--raised`, `--border`, `--highlight`, `--dim`, `--sp-*`, `--fs-sm`, `--radius-md`, `--shadow`.
   - **Parallel with step 3**

### Phase 3: Web UI — model picker logic

5. **Model picker module**
   - Create `web/src/status/model-picker.ts`.
   - Exports `initModelPicker(btn: HTMLButtonElement, panel: HTMLElement, send: (msg: object) => void): ModelPicker`.
   - `ModelPicker` API: `{ setModels(models: ModelDetail[], active: string), close() }`.
   - On open (`onOpen` callback in `createPanelGroup`):
     - Send `model_list` WS message.
     - On response: render the list, filter by search input, show/hide recents section.
   - Search filter: case-insensitive substring match on `id` OR `name`. Empty query shows all. When searching, hide the recents section.
   - Recents: read `localStorage.getItem("vise-recent-models")` (JSON array of model IDs, most-recent-first, max 5). Render as a separate section above the main list. Clicking a recent item also adds it to the top of recents. Write back to localStorage on every model switch.
   - On click of a model item:
     - Send `model_set` WS message with the model ID.
     - Update the button text to the model's name (or ID if no name).
     - Close the panel.
     - Update recents in localStorage.
   - Button shows the active model's **name** (truncated with CSS ellipsis, max-width same as old `<select>`: 13rem). Title attribute shows full ID.
   - **Depends on 1, 2, 3, 4**

6. **Wire into `app.ts`**
   - In `web/src/app.ts`:
     - Import and call `initModelPicker`.
     - Register the panel with `createPanelGroup().register({ button: modelBtnEl, panel: modelPanelEl, onOpen: () => modelPicker.refresh() })`.
     - Remove the old `modelSelect.addEventListener("change", ...)` handler and `populateModelSelect` call.
     - Update `web/src/initial-load.ts`: replace `requestLine("/model")` with a `model_list` WS message (or keep both — the `model_list` response feeds the picker, the old `/model` result can be dropped).
     - Update `web/src/command-results.ts`: the `"switched to model <name>"` handler no longer needs to update a `<select>`; the picker handles it. But keep it for the `/model <id>` line still sent from the composer/terminal.
     - The composer autocomplete (`web/src/composer/composer.ts`): keep using the existing `models: string[]` list from the old `listModels()` path (or switch to the new data). Low priority — the dropdown works either way.
   - **Depends on 5**

### Phase 4: Edge cases & polish

7. **Local (llama.cpp) mode**
   - When the provider is local, `listModelDetails()` returns entries with `name: undefined`. The picker shows the raw ID as the name, no badges (context_length and vision are unknown from llama.cpp's `/v1/models`). Same search works.
   - The button still shows the ID (no name to display).

8. **Error handling**
   - If `model_list` fails (network error, server unreachable), the panel shows "Could not load models" in the list area. The button keeps its previous text.
   - If `model_set` fails, show a brief inline error in the panel (or a toast) and don't close.

9. **OpenRouter model `name` field**
   - OpenRouter's `/models` returns a `name` field for most models (e.g., "Anthropic Claude Sonnet 4"). Use it when present. Fall back to the `id` when absent.
   - Some models may have verbose names — truncate in CSS (max-width + ellipsis on the name span, full text in `title` attribute).

**Relevant files**

- `src/client/llm.ts` — extend `ModelsResponse` type, add `listModelDetails()` method (line ~40 for the type, line ~300 for the fetch pattern to copy)
- `src/client/provider.ts` — existing `ModelInfo` and `modelInfo()` function (line 90-112); the new `ModelDetail` type supersedes this for list display
- `src/web/api/model-api.ts` — **new file**: `model_list` and `model_set` handlers (pattern: `src/web/api/mcp-api.ts` or `notes-api.ts`)
- `src/web/server.ts` — register the new message handlers alongside existing API handlers
- `web/index.html` — replace `<select id="model">` with button + panel (line ~53)
- `web/src/app.ts` — wire the picker, register with `createPanelGroup` (line ~281-294), remove old `<select>` logic (line ~269-271)
- `web/src/status/model-picker.ts` — **new file**: the picker module
- `web/src/initial-load.ts` — replace `requestLine("/model")` with `model_list` WS call (line ~176)
- `web/src/settings/panels.ts` — remove or repurpose `populateModelSelect` (line ~70)
- `web/src/command-results.ts` — update model switch echo handling (line ~34-37)
- `web/styles/topbar.css` — add `.model-panel` positioning override (anchor near button, not far-right)
- `web/styles/controls.css` — add `.model-item`, `.model-section`, `.model-name`, `.model-id`, `.model-meta` classes (or in a new CSS file)

**Verification**

1. **Type check**: `bunx tsc --noEmit` (server/core) and `bun run typecheck:web` (browser) both pass.
2. **Manual — OpenRouter**: Set provider to OpenRouter in settings. Open the model dropdown. Verify: hundreds of models listed with names, context badges, vision icons. Type "sonnet" in search — list filters. Click a model — button text changes, panel closes. Open again — "Recently used" section shows that model at top. Switch to a local model → recents updates.
3. **Manual — Local llama.cpp**: With local provider, open the dropdown. Verify: only the 1-3 loaded models show (IDs, no names, no badges). Search works. Switching works.
4. **Manual — Busy state**: Start a long turn. Open the model dropdown while the turn is running. Verify: the dropdown opens instantly (not queued behind the turn), and switching models takes effect immediately.
5. **Manual — Composer autocomplete**: Type `/model` in the composer during a turn. Verify: the autocomplete still works (uses the old `listModels()` path or the new one — either is fine).
6. **Test**: `bun test` passes (no existing tests reference `populateModelSelect` or the `<select id="model">` directly — verify with `bun test` and fix any that break).
7. **Edge case — private window**: Open the web UI in a private/incognito window. Verify: localStorage read/write is wrapped in try/catch, recents just don't persist, no crash.

**Decisions**

- **Dedicated WS messages** (`model_list`, `model_set`) instead of reusing the `/model` command line. Rationale: the command line is queued behind running turns; a dropdown should respond instantly. Follows the established pattern of `notes_list`, `profiles_list`, `mcp_get`, etc.
- **Keep `listModels()` unchanged** on `LlmClient`. Add a new `listModelDetails()` alongside. The old path serves `ModelController` (terminal `/model`, composer autocomplete) and stays working.
- **Recents in localStorage, not on the server.** 5 most-recently-used model IDs, per browser. Simple, no server state, survives reloads. Lost in private windows (acceptable).
- **No provider grouping.** Flat list with search. Provider prefixes are visible in the ID subtitle (e.g., "anthropic/claude-sonnet-4") and searchable, but no collapsible sections. Keeps the UI simple; search is the primary navigation.
- **No price display.** Context + vision are the useful at-a-glance facts. Price varies by provider and changes; it's better on the OpenRouter website.
- **Profile `<select>` stays as-is.** Only the model picker is upgraded in this plan.

**Further Considerations**

1. **Virtualization**: OpenRouter has 200+ models. A plain `<ul>` with 200 `<li>` items is fine (no virtualization needed at that scale). If the list grows to 1000+, we'd add a simple scroll-window. Not needed now.
2. **Keyboard navigation**: Arrow up/down to move highlight, Enter to select, type-to-jump (filter by typed characters). The search input already handles typing; arrow keys are a nice-to-have. Recommendation: implement arrow keys in the same pass (it's ~20 lines of code for `keydown` on the panel). If scope-creeping, defer.
3. **`/model` terminal command output**: The terminal still uses `formatModelList` which caps at 40. That's fine — the terminal is for power users who type IDs. No change needed.
