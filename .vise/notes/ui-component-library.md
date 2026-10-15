## Plan: UI Component Library

Extract a simple component library from Vise's web UI. Each component is a self-contained module with its own `.ts` (rendering logic) and `.css` (styles), replacing the current 12-file centralized `web/styles/` directory. The component library is shared between the main web UI and the Firefox extension sidebar.

**Why:** the current CSS is organized by _page region_ (transcript.css, composer.css, workspace.css…) not by _component_. Reusing a button style in a new panel means reaching into `controls.css` and hoping the class name still matches. Refactoring one widget touches 5 files. A component library makes each widget self-contained: change a Button and only `button.ts` + `button.css` change.

**Approach:**

1. Define the primitive component set (Button, Field, List, Panel, Badge, Dialog, Toast, Menu, StatusPill).
2. Extract each into `web/src/components/<name>/` as `<name>.ts` + `<name>.css`.
3. Co-locate remaining feature-level CSS with its TS module (each feature directory gets its own `.css`).
4. Refactor features to compose primitives instead of raw class names.
5. Wire the same components into the extension sidebar (replace inline hardcoded CSS with token-based component styles).

---

### Phase 1 — Component library scaffold

**1a. Directory structure.**

```
web/src/components/
  index.ts          — re-exports all components
  button/
    button.ts       — createButton(opts): HTMLButtonElement
    button.css      — .vise-btn, .vise-btn-primary, .vise-btn-danger, .vise-btn-sm
  field/
    field.ts        — createField({label?, type?, placeholder?}): HTMLInputElement
    field.css       — .vise-field, .vise-field-label
  list/
    list.ts         — createList(items, opts): HTMLElement
    list.css        — .vise-list, .vise-list-item
  panel/
    panel.ts        — createPanel({title?, actions?}): HTMLElement
    panel.css       — .vise-panel, .vise-panel-header, .vise-panel-body
  badge/
    badge.ts        — createBadge({text, tone}): HTMLElement
    badge.css       — .vise-badge, .vise-badge-ok, .vise-badge-warn, .vise-badge-error
  dialog/
    dialog.ts       — showDialog({title, body, actions}): Promise<ActionId | null>
    dialog.css      — .vise-dialog, .vise-dialog-actions
  toast/
    toast.ts        — showToast({text, tone}): void
    toast.css       — .vise-toast, .vise-toast-ok, .vise-toast-error
  menu/
    menu.ts         — showMenu(x, y, items): Promise<ItemId | null>
    menu.css        — .vise-menu, .vise-menu-item, .vise-menu-item-danger
  status-pill/
    status-pill.ts  — createStatusPill(): HTMLElement with .set(state)
    status-pill.css — .vise-status, .vise-status-connected, .vise-status-working, .vise-status-offline
```

Each component's `.ts` exports a factory function that creates and returns DOM. The `.css` uses only the shared tokens from `tokens.css` (never hard-coded hex). Class names are prefixed `vise-` to avoid collisions with feature CSS.

**1b. `web/src/components/index.ts`** — barrel re-export:

```ts
export { createButton } from "./button/button.ts";
export { createField } from "./field/field.ts";
// etc.
```

**1c. CSS import convention.** Each `.ts` file imports its own `.css` directly:

```ts
// button/button.ts
import "./button.css";
```

Bun bundles imported CSS into the output. The global `web/styles/index.css` `@import` chain is **replaced** by explicit imports from `web/src/app.ts` (or a new `web/src/styles.ts` that imports tokens + base first, then each component and feature CSS in dependency order). Order: `tokens.css` → `base.css` → components → features.

**Depends on:** nothing (green-field structure).

---

### Phase 2 — Extract primitives from existing CSS

For each primitive, move the relevant rules from `web/styles/controls.css` (and other feature CSS files) into the component's `.css`, and create the `.ts` factory that returns DOM with the right classes.

**2a. Button** — from `controls.css` `.btn`, `.btn.primary`, `.btn.danger`, `.btn.small`.

- `createButton({ label, primary?, danger?, small? })` → `<button class="vise-btn [vise-btn-primary] [vise-btn-danger] [vise-btn-sm]">label</button>`.
- Refactor call sites: search for `class="btn"` in `web/src/` → replace with `createButton()`.

**2b. Field** — from `controls.css` `.field`.

- `createField({ label?, type?, placeholder?, value? })` → wrapped `<div class="vise-field"><label class="vise-field-label">…</label><input class="vise-field-input" …></div>`.
- Refactor call sites in settings panels, composer, etc.

**2c. List** — from `controls.css` `.list`, `.list-item`.

- `createList(items: { id, label, meta?, danger? }[], opts?)` → `<ul class="vise-list"><li class="vise-list-item">…</li></ul>`.
- Refactor: tools panel, session list, profile list, notes list, workflow list.

**2d. Panel** — from `controls.css` `.two-pane` and the panel header/body pattern used in settings and tools.

- `createPanel({ title, actions? })` → `<div class="vise-panel"><header class="vise-panel-header"><span>title</span><div class="vise-panel-actions">…</div></header><div class="vise-panel-body">…</div></div>`.
- Refactor: settings tabs, tools dropdown, git panel.

**2e. Badge** — from `controls.css` (if present) or `topbar.css` status indicators.

- `createBadge({ text, tone: "ok" | "warn" | "error" })` → `<span class="vise-badge vise-badge-ok">text</span>`.
- Refactor: status pill area, extension sidebar badges.

**2f. Dialog** — from `web/styles/feedback.css` (confirm dialog) and `web/src/feedback/confirm.ts`.

- `showDialog({ title, body, actions: { id, label, primary? }[] })` → returns a Promise resolving with the clicked action's `id` or `null` (Escape/Cancel).
- Replaces the ad-hoc `<dialog>` creation in `confirm.ts`.
- Refactor: `confirmAction`, `ifConfirmed`, any other `<dialog>` usage.

**2g. Toast** — from `web/styles/feedback.css` and `web/src/feedback/toast.ts`.

- `showToast({ text, tone?: "ok" | "error" })` → appends a `<div class="vise-toast …">` to a fixed container, auto-removes after 4 s.
- Refactor: replace existing `toast()` in `web/src/feedback/toast.ts` (keep the export name as an alias for compatibility).

**2h. Menu** — from `web/styles/feedback.css` (context menu) and `web/src/workspace/tab-menu.ts`.

- `showMenu(x, y, items: { id, label, danger?, disabled? }[])` → positions a `<div class="vise-menu">` at (x,y), returns the clicked item's `id` or `null`.
- Refactor: `showMenu` in `tab-menu.ts`, any other context-menu usage.

**2i. StatusPill** — from `web/styles/topbar.css` and `web/src/status/pill.ts` (or wherever the connected/working/disconnected pill lives).

- `createStatusPill()` → `<span class="vise-status">` with `.set("connected" | "working" | "offline")` method.
- Refactor: the topbar's status indicator.

**Depends on:** Phase 1 (directory + import convention).
**Parallelism:** 2a–2i are independent of each other; each is a small (30–80 line) extraction. They can be done in any order or parallelized.

---

### Phase 3 — Co-locate feature CSS

Move the remaining feature-level CSS (everything not extracted into primitives) from `web/styles/` into the feature's own directory.

| Source file                          | Target                                                              | What remains after extracting primitives                                |
| ------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `web/styles/transcript.css` (502 ln) | `web/src/transcript/transcript.css`                                 | chat line styles, code block styling, thinking collapse, image/lightbox |
| `web/styles/composer.css` (329 ln)   | `web/src/composer/composer.css`                                     | textarea, steer/queue buttons, ask-choices, slash-command bar           |
| `web/styles/workspace.css` (412 ln)  | `web/src/workspace/workspace.css`                                   | file tree, viewer, tab strip, git status colors                         |
| `web/styles/topbar.css` (319 ln)     | `web/src/menubar/topbar.css`                                        | menu bar layout, dropdown positioning, model/profile selects            |
| `web/styles/settings.css` (276 ln)   | `web/src/settings/settings.css`                                     | tab list, form layout, env panel specific styles                        |
| `web/styles/feedback.css` (213 ln)   | `web/src/feedback/feedback.css`                                     | whatever remains after dialog/toast/menu extraction                     |
| `web/styles/terminal.css` (54 ln)    | `web/src/terminal/terminal.css`                                     | panel wrapper (xterm keeps its own)                                     |
| `web/styles/layout.css` (114 ln)     | `web/src/layout.css` (or keep in `web/styles/` as the shell layout) | the flexbox grid for the page                                           |
| `web/styles/base.css` (82 ln)        | `web/src/base.css` (or keep in `web/styles/`)                       | reset, body, scrollbar tokens                                           |

Each feature's `.ts` (or the module's entry) imports its own `.css`:

```ts
// web/src/transcript/transcript.ts
import "./transcript.css";
```

**`web/styles/tokens.css`** stays where it is — it's the global token layer, imported first by everything.

**Delete** `web/styles/index.css` and the old `@import` chain. Replace with a single `web/src/styles.css` (or inline imports in `app.ts`) that imports in the correct order:

```css
@import "../../styles/tokens.css"; /* or import from the TS entry */
@import "./base.css";
@import "./layout.css";
@import "../components/index.css"; /* or individual component CSS via the TS barrel */
@import "./transcript/transcript.css";
@import "./composer/composer.css";
@import "./workspace/workspace.css";
@import "./menubar/topbar.css";
@import "./settings/settings.css";
@import "./feedback/feedback.css";
@import "./terminal/terminal.css";
```

Actually, since Bun handles CSS imports from TS, the cleanest approach is: `web/src/app.ts` (or a dedicated `web/src/styles.ts` imported by `app.ts`) does:

```ts
import "../styles/tokens.css";
import "./base.css";
import "./layout.css";
import "../components/index.css"; // or import each component CSS in order
import "./transcript/transcript.css";
import "./composer/composer.css";
// etc.
```

Bun flattens all imported CSS into the output in import order.

**Depends on:** Phase 2 (the feature CSS files need to have the extracted primitive rules removed first, so they don't duplicate).

---

### Phase 4 — Refactor features to use primitives

Replace raw DOM + class-name patterns in feature code with the component factories.

**4a. `web/src/feedback/confirm.ts`** → use `showDialog` from `components/dialog/`.
The existing `confirmAction` / `ifConfirmed` become thin wrappers calling `showDialog` with the right actions. The `<dialog>` element creation moves into `dialog.ts`.

**4b. `web/src/feedback/toast.ts`** → use `showToast` from `components/toast/`.
The existing `toast()` function body becomes a call to the component. Keep the export name for all existing callers.

**4c. `web/src/workspace/tab-menu.ts`** → use `showMenu` from `components/menu/`.
The existing `showMenu(x, y, items)` delegates to the component. Keep the `MenuItem` type as a re-export.

**4d. Settings panels** (`web/src/settings/`) → use `createPanel`, `createField`, `createList` where they apply.

- The settings tab list → `createList`
- Form rows → `createField`
- The tab container → `createPanel`

**4e. Tools dropdown, git panel, profiles panel** → use `createPanel`, `createList`, `createButton`.

**4f. Composer** (`web/src/composer/`) → use `createButton` for the send/steer/queue buttons, `createField` for the textarea wrapper (if applicable).

**4g. Topbar** (`web/src/menubar/`) → use `createStatusPill`, `createButton` for the ⚙ button.

**4h. Extension sidebar** (`extension/src/sidebar.ts`) → use `createBadge` (or the CSS tokens directly) for the status badges.

**Depends on:** Phases 2 and 3 (components must exist and feature CSS must be co-located before refactoring call sites).

---

### Phase 5 — Extension sidebar: share tokens and components

The extension sidebar currently has all CSS inlined in `extension/sidebar.html` with hard-coded hex values (`#e6e6e6`, `#15171c`, `#333`, etc.). To share the component library:

**5a. Extract the sidebar's CSS into a file.**

- Create `extension/src/sidebar.css` — move the `<style>` block content there.
- Replace hard-coded values with the same CSS custom properties as `tokens.css` (`--bg`, `--panel`, `--text`, `--dim`, `--accent`, `--border`, `--user`, `--error`, etc.).
- The extension doesn't load `tokens.css` (it's a separate page, not the web app), so create a minimal `extension/src/tokens.css` that defines the same variable names with the same values as the web UI's dark theme. This is a small (~30 line) file that could be generated from `tokens.css` by a build script, or hand-maintained (it's stable).

**5b. Use shared component CSS.**

- The sidebar's `#badge` (ok/warn/bad) maps to the `Badge` component. Either:
  - **Option A (light):** Import the component's `.css` into the extension build. Add `import "../../web/src/components/badge/badge.css"` (or a copy) to the extension's sidebar HTML. The badge CSS only uses tokens, so it works as long as the tokens are defined.
  - **Option B (full):** Build a small component bundle for the extension: `bun build` a tiny entry that imports the needed component CSS and the extension's own CSS, outputting a single `sidebar.css`.
  - **Recommendation:** Option A for v1 — just import the component CSS files that the sidebar uses. The sidebar is simple enough that a full component build is overkill.

**5c. `extension/sidebar.html`** — replace the inline `<style>` block with a `<link>` to the built CSS (or keep it inline but sourced from the component files during build). The `bun run build:ext` step already compiles the extension; extend it to also bundle the CSS.

**5d. `extension/src/sidebar.ts`** — where it creates badge DOM, use the shared `createBadge()` factory (or at least apply the shared class names `vise-badge vise-badge-ok` etc.).

**Depends on:** Phases 2 and 4 (the components must exist and be stable before the extension adopts them).

---

### Phase 6 — Build and bundle changes

**6a. Web UI build.** `bun build` (via `bun run dev:web` or `bun run build:web`) already follows CSS imports from TS. The new per-component imports are picked up automatically. Verify the output `web/dist/app.css` has the same rules in the same order (tokens first, then components, then features).

**6b. Extension build.** `bun run build:ext` currently compiles `extension/src/*.ts` to `extension/dist/*.js`. Extend it to also produce a `extension/dist/sidebar.css` (or inline the CSS into the HTML). The build script is in `scripts/` or `package.json` — find the exact command and add the CSS bundling step.

**6c. Delete `web/styles/` directory** (or keep only `tokens.css` + `base.css` + `layout.css` if they remain as the "global" layer). Remove the old `@import` chain from `web/src/app.ts`.

**Depends on:** All prior phases.

---

### Relevant files

- `web/styles/index.css` — **delete** (replaced by TS-side imports)
- `web/styles/tokens.css` — **keep** (global tokens, the single shared file)
- `web/styles/base.css` — **move** to `web/src/base.css` or keep in `web/styles/` (the reset + scrollbar tokens)
- `web/styles/controls.css` — **dissolve** (rules move into individual component CSS files)
- `web/styles/layout.css` — **move** to `web/src/layout.css`
- `web/styles/topbar.css` — **move** to `web/src/menubar/topbar.css` (or `web/src/status/topbar.css`)
- `web/styles/transcript.css` — **move** to `web/src/transcript/transcript.css`
- `web/styles/composer.css` — **move** to `web/src/composer/composer.css`
- `web/styles/workspace.css` — **move** to `web/src/workspace/workspace.css`
- `web/styles/settings.css` — **move** to `web/src/settings/settings.css`
- `web/styles/feedback.css` — **move** to `web/src/feedback/feedback.css`
- `web/styles/terminal.css` — **move** to `web/src/terminal/terminal.css`
- `web/src/app.ts` — update the CSS import from `"../styles/index.css"` to the new per-module imports
- `web/src/feedback/confirm.ts` — refactor to use `showDialog`
- `web/src/feedback/toast.ts` — refactor to use `showToast`
- `web/src/workspace/tab-menu.ts` — refactor to use `showMenu`
- `web/src/settings/` — refactor to use `createPanel`, `createField`, `createList`
- `web/src/composer/` — refactor to use `createButton`
- `web/src/menubar/` — refactor to use `createStatusPill`, `createButton`
- `extension/sidebar.html` — extract inline CSS, use shared component CSS
- `extension/src/sidebar.ts` — use shared class names / component factories
- `extension/src/sidebar.css` — **new** (or `extension/src/tokens.css`)

**New files:**

- `web/src/components/index.ts`
- `web/src/components/button/button.ts` + `button.css`
- `web/src/components/field/field.ts` + `field.css`
- `web/src/components/list/list.ts` + `list.css`
- `web/src/components/panel/panel.ts` + `panel.css`
- `web/src/components/badge/badge.ts` + `badge.css`
- `web/src/components/dialog/dialog.ts` + `dialog.css`
- `web/src/components/toast/toast.ts` + `toast.css`
- `web/src/components/menu/menu.ts` + `menu.css`
- `web/src/components/status-pill/status-pill.ts` + `status-pill.css`

---

### Verification

1. **`bunx tsc --noEmit`** — no type errors from the new `web/src/components/` modules.
2. **`bun run typecheck:web`** — browser code type-checks.
3. **`bun run lint`** — ESLint passes on all new files.
4. **`bun test`** — existing tests pass (no component-specific unit tests needed for v1; the components are thin DOM factories. Add a smoke test in `test/web/` that imports a component and asserts the returned DOM has the right class names).
5. **`bun run dev:web`** — build succeeds; open the web UI and verify:
   - All buttons, fields, lists, panels, dialogs, toasts, menus render identically to before.
   - Theme switching (all 6 themes) works — components pick up the token changes.
   - The settings panel, tools dropdown, git panel, file explorer, transcript, composer all look the same.
6. **`bun run build:ext`** — extension builds; load in Firefox (`about:debugging`), verify the sidebar looks the same and the status badges use the shared styles.
7. **`bun run build:exe`** — full compile works (the CSS is embedded via `web/src/assets.ts` / `src/web/assets.ts` which imports the built bundle; confirm the new CSS paths resolve).
8. **No duplicate rules:** search the built `web/dist/app.css` for any class name that appears in both a component CSS and a feature CSS — there should be zero overlap.

---

### Decisions

- **`vise-` prefix** on all component class names (`.vise-btn`, `.vise-field`, `.vise-list`, etc.) to avoid collisions with feature-level classes. The existing `.btn`, `.field`, `.list`, `.two-pane` classes are **renamed** to the `vise-` prefix in this refactor (a one-pass find-and-replace in the feature CSS files + TS call sites).
- **No component framework.** These are plain factory functions returning DOM — no JSX, no lit, no htm. The existing code style is `document.createElement` + class assignments; the components keep that style.
- **Tokens stay global.** One `tokens.css` for the web UI. The extension gets a small mirror file (`extension/src/tokens.css`) with the same variable names and values. If themes are ever added to the extension, the extension's tokens file grows.
- **No CSS modules or CSS-in-JS.** Plain `.css` files imported by `.ts`. Bun's native CSS import handles bundling.
- **Feature CSS keeps feature-specific selectors.** For example, `transcript.css` still has `.line.user`, `.line.assistant`, `.thinking`, etc. Those are not extracted into components — they're specific to the transcript feature.
- **The `@import` chain is replaced by TS imports.** Bun flattens imported CSS in order. No `index.css` needed.
- **Extension v1 is light:** it imports the specific component CSS files it needs (badge, maybe button). It does not build a full component library bundle. If the sidebar grows, revisit.

### Scope boundaries

- **Included:** component extraction, CSS co-location, feature refactoring to use components, extension sidebar sharing.
- **Excluded:** CSS-in-JS, a component build tool (lit, stencil, etc.), a visual regression test suite, CSS modules / scoped styles, automatic token synchronization between web and extension (manual for now), TypeScript component type definitions (the factories return `HTMLElement`; no generic constraints in v1).
