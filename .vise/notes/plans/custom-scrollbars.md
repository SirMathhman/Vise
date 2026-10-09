## Plan: Custom Scrollbars for Web UI

Replace browser-default scrollbars with theme-matched ones: neutral-grey thumbs by default, accent-colored on hover, only visible when content overflows (no layout shift). Xterm terminal stays as-is.

**Steps**

1. **Add scrollbar CSS to `web/styles.css`** (single change, after the `:root` block around line 10):
   - Add two CSS custom properties to `:root` for the scrollbar colors, following the existing naming convention:
     - `--scroll-track: var(--bg)` — track background (invisible against the page)
     - `--scroll-thumb: color-mix(in srgb, var(--border) 80%, var(--text))` — a muted grey between border and text, visible but subtle
     - `--scroll-thumb-hover: color-mix(in srgb, var(--accent) 50%, transparent)` — accent tint on hover
   - Add a scoped global rule for **WebKit** (Chrome, Edge, Safari):
     - `*::-webkit-scrollbar { width: 8px; height: 8px; }` — thin scrollbars, both axes
     - `*::-webkit-scrollbar-track { background: transparent; }` — track is invisible (the `--bg` page shows through)
     - `*::-webkit-scrollbar-thumb { background: var(--scroll-thumb); border-radius: 4px; }` — rounded thumb
     - `*::-webkit-scrollbar-thumb:hover { background: var(--scroll-thumb-hover); }` — accent on hover
     - `*::-webkit-scrollbar-corner { background: transparent; }` — corner where horizontal and vertical meet
   - Add the **Firefox** equivalent on the same `*` selector:
     - `scrollbar-width: thin;` — thin scrollbar (Firefox only; `auto` = default, `thin` = smaller)
     - `scrollbar-color: var(--scroll-thumb) var(--scroll-track);` — Firefox doesn't support hover pseudo-elements for scrollbars, so this is the best it can do; the default state will match
   - **Exclude xterm:** add `.xterm::-webkit-scrollbar { display: none; }` and `.xterm { scrollbar-width: none; }` so the terminal's viewport keeps its own behavior. Actually, xterm renders its own scroll view inside `.xterm-viewport`, so the rule should be: `.xterm-viewport::-webkit-scrollbar { display: none; }` and `.xterm-viewport { scrollbar-width: none; }`.

2. **Verify no layout shift** — because we're using `*::-webkit-scrollbar` (not overlay), the scrollbar takes up space when visible (same as default). The `width: 8px` is slightly narrower than the default ~15px, which will cause a tiny layout shift on resize. This is acceptable per the "auto" visibility decision (same behavior as current, just restyled). No JS needed.

3. **Test in browser** — open the web UI (`bun run web` or `bun run dev:web`), verify:
   - Chat log scrollbar: thin grey, turns blue on hover
   - Tools dropdown, file tree, settings page body: same treatment
   - File tab strip (horizontal): thin horizontal scrollbar styled the same
   - Xterm terminal: scrollbar unchanged (default)
   - Content that doesn't overflow: no scrollbar visible (same as before)
   - Resize window / scroll: no jarring layout jumps beyond the ~7px narrower scrollbar

**Relevant files**

- `web/styles.css` — the only file to modify. Add the `:root` variables and the scrollbar rules after the existing `:root` block (line 10).
- `web/src/terminal/terminal-panel.ts` — reference only; it reads `--bg`, `--text`, `--accent`, `--border` via `getComputedStyle`. The new `--scroll-*` variables don't affect it.
- `web/index.html` — loads `styles.css` and `dist/app.css`; no changes needed.
- `web/dist/app.css` — xterm.js bundle; do not edit. Its `.xterm-viewport { overflow-y: scroll }` is what the exclusion rule targets.

**Verification**

1. `bun run dev:web` — open the web UI in a browser
2. Scroll the chat log with long content — confirm thin grey scrollbar, accent on hover
3. Open the tools panel, file tree, and settings — confirm same styling
4. Open the terminal panel — confirm its scrollbar is unchanged
5. `bunx tsc --noEmit` and `bun run typecheck:web` — no type errors (this is pure CSS so should pass, but confirms nothing else broke)
6. `bun test` — full test suite passes

**Decisions**

- Neutral-grey thumb (between `--border` and `--text`), accent tint on hover — subtle by default, interactive highlight on engagement
- `auto` visibility: scrollbars appear only when content overflows, same as current behavior, just restyled. No overlay/fade animation, no JS.
- 8px wide (default is ~15px on Windows) — noticeable improvement without being so thin it's hard to grab
- Xterm excluded: it manages its own scroll viewport and its scrollbar styling is fiddly; the default looks fine there
- No new file: everything lives in `web/styles.css` alongside the rest of the app CSS
- Firefox gets `scrollbar-width: thin` + `scrollbar-color` (no hover support in Firefox for scrollbar pseudo-elements, so the default state is the best achievable)
