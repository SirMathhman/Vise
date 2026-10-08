## Plan: Light/Dark Theme System

Add a simple light/dark theme to the web UI. Dark is the existing look; light is a new palette. Default follows the OS `prefers-color-scheme`; the user can override via a toggle in the settings panel (general tab). The preference persists in `localStorage` and survives reloads.

**Steps**

### Phase 1 — CSS: light theme variables and hardcoded-color audit

1. In `web/styles.css`, keep the existing `:root { ... }` block as the **dark** theme (it already is). Add a `[data-theme="light"]` selector with light values for every existing variable:
   - `--bg`, `--panel`, `--text`, `--dim`, `--accent`, `--user`, `--error`, `--border`
   - Pick reasonable light values (white/near-white backgrounds, dark text, slightly muted accent).

2. Introduce new variables for the hardcoded colors that escaped the theme system (convert each use to `var(--...)`):
   - `--goal-ok` (replaces `#8fe3a4` at line 264)
   - `--goal-warn` (replaces `#f0d77a` at line 268)
   - `--goal-ask` (replaces `#ffb3ad` at line 272)
   - `--suggestion-bg` (replaces `#252832` at line 618, `.command-suggestion.active`)
   - `--text-on-accent` (replaces `#0b0e14` at lines 646 and 1357 — text on the accent button/progress bar)
   - `--error-strong` (replaces `#e06050` at line 754, `.session-delete:hover`)
   - `--backdrop` (replaces `rgb(0 0 0 / 0.8)` at line 1263, `.lightbox`)
   - `--shadow` (replaces `rgb(0 0 0 / 30%)` at line 598 and `rgba(0,0,0,0.5)` at line 1021)
   - The two `#fff` at lines 1059 and 1066 (`.files-frame` / `.browser-view`) are **intentionally white** (external content); leave them as `#fff` — they look correct in both themes.

3. Fix the dangling `var(--muted)` at line 737 — change to `var(--dim)` (the variable was never defined; `--dim` is the intended "secondary text" color).

4. Define every new variable in **both** the `:root` (dark) block and the `[data-theme="light"]` block.

### Phase 2 — Theme module: `web/src/theme.ts`

Create a new small module (follows the `restore-root.ts` pattern exactly):

1. **Constants**: `const KEY = "vise-theme";` values are `"dark"` or `"light"`.

2. **`resolveTheme(): "dark" | "light"`**: read `localStorage.getItem(KEY)` (try/catch); if a value is present and valid, return it; otherwise return the OS preference via `window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"`.

3. **`applyTheme(theme: "dark" | "light")`**: set `document.documentElement.dataset.theme = theme` (or remove the attribute for dark, since dark is the default and no attribute is the current state). This makes the CSS variables switch.

4. **`setTheme(theme: "dark" | "light" | "auto")`**: if `"auto"`, remove the `localStorage` key (return to OS-following); otherwise write it. Then call `applyTheme(resolveTheme())`.

5. **`initTheme()`** (exported, called at module import time or from `app.ts`):
   - Calls `applyTheme(resolveTheme())` — this is the pre-paint hook.
   - If no explicit preference is set, adds a `matchMedia("(prefers-color-scheme: light)")` change listener that re-applies when the OS switches (only when no stored preference).

6. **`getTheme(): "dark" | "light" | "auto"`**: returns the effective setting (stored value or `"auto"`) for the UI to show.

The module is self-contained: no server messages, no connection dependency — purely client-side.

### Phase 3 — UI toggle in settings panel

1. In `web/index.html`, inside the `#settings-general` tab div, add a small static block (a `<label>` + `<select>` or three radio buttons: Auto / Dark / Light) with an id like `#theme-select`. This is a client-only control (no `env_get`/`env_set`), so it does not belong in the env panel's dynamic content.

2. In the theme module (or a small section of `app.ts` that calls theme functions), wire the `<select>`:
   - On `change`, call `setTheme(value)` and update the select's own state.
   - On settings panel open (or app init), call `getTheme()` to set the select's initial value.

3. The select is a plain `<select>` with three `<option>`s: `auto` (default, "Follow system"), `dark`, `light`. No new CSS beyond what the existing settings panel already styles.

### Phase 4 — Wire into app entry

1. In `web/src/app.ts` (or the module it imports first — whatever runs before the first meaningful paint), import `theme.ts`. The import side-effect (`initTheme()` call or module-level `applyTheme`) sets `data-theme` on `<html>` before the browser paints the page.

2. Verify import order: the theme module must run before `app.ts` grabs DOM elements and before the first render frame. The `restore-root.ts` import already establishes that early imports work; follow that pattern.

### Phase 5 — Verification

1. **Dark by default**: load the page with no `vise-theme` in localStorage and OS set to dark mode → page is dark (no `data-theme` attribute, `:root` values apply).
2. **Light by default (OS)**: set OS to light mode, clear localStorage → page is light (`data-theme="light"` on `<html>`).
3. **Toggle**: open settings → general → switch to "Light" → page switches live, `vise-theme` appears in localStorage. Switch back to "Auto" → key is removed, OS preference applies again.
4. **Persistence**: set to "Light", reload → stays light.
5. **OS change while open** (auto mode): no stored preference, change OS theme while page is open → page follows.
6. **Type-check**: `bun run typecheck:web` passes.
7. **Visual check**: go through every UI section (chat log, settings panel, workspace/file tree, browser view, sessions panel, composer) in both themes and confirm no unreadable text, no missing contrast.

**Relevant files**

- `web/styles.css` — add `[data-theme="light"]` block, new variables, convert hardcoded colors, fix `--muted` → `--dim`.
- `web/src/theme.ts` — **new file**. The entire theme logic (read, resolve, apply, persist, OS listener).
- `web/index.html` — add the theme `<select>` inside `#settings-general`.
- `web/src/app.ts` — import `theme.ts` early (before DOM setup) so it applies pre-paint.
- `web/src/restore-root.ts` — **reference only** (the `localStorage` read/write pattern to copy).
- `web/src/settings-panels.ts` — **reference only** (shows how the settings general tab is structured; the theme select is static HTML, not created by this module).

**Decisions**

- **Default**: follow OS (`prefers-color-scheme`). No stored preference = follow OS. This matches the user's choice.
- **Toggle location**: settings panel, general tab. Client-only setting (no server message needed).
- **Persistence**: `localStorage` key `vise-theme`, same defensive try/catch pattern as `vise-root` in `restore-root.ts`.
- **Selector**: `[data-theme="light"]` on `<html>`. No attribute = dark (preserves current behavior with zero CSS changes for the default).
- **Scope**: web UI only. The terminal/ANSI colors (`src/output/color.ts`) and the extension's sidebar (which embeds the web UI, so it inherits the theme automatically) are unaffected.
- **Excluded**: per-section theme overrides, user-defined custom themes, theme export/import, `@media (prefers-color-scheme)` as the sole mechanism (we use JS to set the attribute, which is more testable and allows the explicit override).

**Further considerations**

1. The extension sidebar embeds `/?ui=sidebar` — it will inherit the theme automatically since it's the same page. No extra work needed. If the extension ever gets its own chrome outside the embedded page, that would need separate handling.
2. If a third "high contrast" theme is ever wanted, the `[data-theme="..."]` pattern extends naturally without restructuring.
