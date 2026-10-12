> **Status:** implemented (the dependency and the `--code-*` tokens had been added earlier, but the renderer, the 
> `.hljs-*` rules and the viewer wiring were missing, so nothing showed). Languages are registered from `highlight.js/lib/core`
> (see `web/src/highlight.ts`), plus bash, powershell, python, yaml and diff.

## Plan: Syntax Highlighting for Web UI

Add highlight.js-based syntax highlighting to fenced code blocks in the chat transcript and the file viewer's text mode. No terminal REPL changes. Focused on TypeScript/JavaScript, JSON, SQL, and CSS/HTML.

**Steps**

### Phase 1 — Install highlight.js

1. **`package.json`** (root) — add `"highlight.js": "^11.x"` to `dependencies`. Run `bun install`. highlight.js ships ES modules; only the core (`highlight.js`) plus the specific language files we import (typescript, json, sql, css, xml) are needed — tree-shaking handles the rest. The bundled web build (`bun build`) will include only what we import.

### Phase 2 — CSS token colours

2. **`web/styles/tokens.css`** — add a small set of code-colour custom properties to each of the 5 theme blocks (`:root`, `[data-theme="light"]`, `forest`, `volcano`, `underwater`). The properties are:
   - `--code-keyword` (if, for, return, SELECT, FROM, @if…)
   - `--code-string` (string literals)
   - `--code-number` (numeric literals)
   - `--code-comment` (comments — dim, italic)
   - `--code-function` (function/method names)
   - `--code-literal` (true, false, null, undefined)
   - `--code-type` (type names, class names, built-ins like Promise, console)
   - `--code-meta` (decorators, @decorator, etc.)
   - `--code-attribute` (JSON keys, CSS property names, HTML attribute names)
   - `--code-operator` (==, =>, +, etc.)
   - `--code-punct` (brackets, semicolons — same as base `--text` or slightly dimmed)

   Dark themes (the default and forest/volcano/underwater): keywords bright, strings greenish/amber, comments dim gray-italic, functions light-blue, types teal, literals orange, meta purple. Light theme: same hues but darker for contrast on white.

3. **`web/styles/transcript.css`** — add rules mapping highlight.js's span classes to the new tokens. highlight.js wraps tokens in `<span class="hljs-keyword">` etc. inside the `<code>` element. Rules needed:
   ```
   .line.assistant code .hljs-keyword { color: var(--code-keyword) }
   .line.assistant code .hljs-string { color: var(--code-string) }
   .line.assistant code .hljs-number { color: var(--code-number) }
   .line.assistant code .hljs-comment { color: var(--code-comment); font-style: italic }
   .line.assistant code .hljs-title { color: var(--code-function) }
   .line.assistant code .hljs-literal { color: var(--code-literal) }
   .line.assistant code .hljs-built_in { color: var(--code-type) }
   .line.assistant code .hljs-type { color: var(--code-type) }
   .line.assistant code .hljs-meta { color: var(--code-meta) }
   .line.assistant code .hljs-attribute { color: var(--code-attribute) }
   .line.assistant code .hljs-operator { color: var(--code-operator) }
   .line.assistant code .hljs-punctuation { color: var(--code-punct) }
   ```
   The existing `.line.assistant pre code` reset (background:none, border:none, padding:0) stays as-is.

4. **`web/styles/workspace.css`** (or wherever the file viewer's `<pre>` is styled) — add the same rules scoped to the viewer's `<pre>`. The viewer will share the exact same token classes since we use the same highlight.js output.

### Phase 3 — Chat code blocks

5. **`web/src/markdown.ts`** — modify `renderMarkdown` to use a custom marked renderer for the `code` method:
   - Import `highlight.js` core and register the four languages: `typescript`, `json`, `sql`, `css`, `xml` (highlight.js calls HTML "xml").
   - Create a custom renderer object with a `code({ text, lang }: Tokens.Code): string` method (marked v18 signature).
   - In `code`: if `lang` is present and `hljs.getLanguage(lang)` is truthy, call `hljs.highlight(text, { language: lang })` and return `<pre><code class="hljs language-{lang}">{result.value}</code></pre>`.
   - Otherwise (no lang, or unsupported lang), return the plain escaped `<pre><code>…</code></pre>` (marked's default, escaped). This is important: code without a language tag must not be highlighted.
   - Pass the renderer as a `renderer` option to `marked.parse`.
   - DOMPurify sanitization stays unchanged — `<span>` elements with class attributes pass through its default config.
   - **Important:** escape the code text before inserting it into HTML. `hljs.highlight` handles escaping internally (its output is already HTML-escaped). For the no-highlight path, use a small `escapeHtml` helper (or marked's own escaping).

6. **`web/src/markdown.ts`** (or a new small module) — register highlight.js language packs. In an ES module, the import is:
   ```
   import hljs from "highlight.js";
   import typescript from "highlight.js/languages/typescript";
   import json from "highlight.js/languages/json";
   import sql from "highlight.js/languages/sql";
   import css from "highlight.js/languages/css";
   import xml from "highlight.js/languages/xml";
   hljs.registerLanguage("typescript", typescript);
   hljs.registerLanguage("json", json);
   hljs.registerLanguage("sql", sql);
   hljs.registerLanguage("css", css);
   hljs.registerLanguage("xml", xml);
   ```
   Only these five languages are loaded into the bundle. Any other language tag (e.g. ```` ```python ````) falls through to the no-highlight path.

### Phase 4 — File viewer

7. **`web/src/workspace/open-tabs.ts`** — add a `highlightLang(path: string): string | undefined` function that maps file extensions to highlight.js language names:
   - `.ts`, `.mts` → `"typescript"`
   - `.js`, `.mjs`, `.cjs` → `"javascript"` (note: `"javascript"` is auto-registered by highlight.js core; no explicit import needed)
   - `.json` → `"json"`
   - `.sql` → `"sql"`
   - `.css` → `"css"`
   - `.html`, `.htm` → `"xml"`
   - anything else → `undefined` (plain text)

   This function is pure (no DOM) and testable.

8. **`web/src/workspace/explorer.ts`** — in `renderViewer`, when `mode === "text"` and the file's extension has a known language:
   - Call `hljs.highlight(file.text, { language: lang })` and set `viewer.innerHTML = `<pre><code class="hljs">${result.value}</code></pre>``.
   - When there is no known language, keep `viewer.textContent = file?.text ?? ""` (plain text).
   - The viewer's `<pre>` element already has `overflow-x: auto` and monospace font; the highlighted output replaces the plain text.
   - **Caveat:** very large files (hundreds of KB) will be slower to highlight. For "extremely simple" we accept this. If it becomes a problem, gate highlighting to files under ~50 KB.

### Phase 5 — Verify

9. **`bunx tsc --noEmit`** — server/core still type-checks.
10. **`bun run typecheck:web`** — web code type-checks with the new imports.
11. **`bun run lint`** — ESLint passes.
12. **`bun test`** — existing tests still pass (no new tests needed for this feature; it's a display-layer change with no new logic to unit-test). Optionally, a small test of `highlightLang` in `test/web/`.
13. **`bun run dev:web`** — build the web bundle. Verify `web/dist/app.js` contains highlight.js output (search for `hljs-keyword` in the bundle).
14. **Manual verification:**
    - Open the web UI, send a message with a TypeScript code block. Confirm keywords, strings, comments, and function names are coloured.
    - Send a message with a JSON, SQL, and HTML code block. Confirm each is coloured.
    - Send a message with a Python code block (unsupported). Confirm it renders as plain text (no highlighting, no error).
    - Open a `.ts` file in the file viewer. Confirm it is highlighted.
    - Open a `.json`, `.sql`, `.css`, `.html` file. Confirm highlighting.
    - Open a `.txt` or unknown-extension file. Confirm plain text.
    - Switch to each of the 5 themes. Confirm the code colours adapt per theme.
    - Verify streaming: start a long reply with a code block in the middle. Confirm the code block re-renders with highlighting each frame without visual glitches.

**Relevant files**

- `package.json` (root) — add `highlight.js` to dependencies
- `web/src/markdown.ts` — `renderMarkdown`: add custom renderer for `code`, register language packs
- `web/src/workspace/open-tabs.ts` — add `highlightLang(path)` extension→language map
- `web/src/workspace/explorer.ts` — `renderViewer`: use `hljs.highlight` for text-mode files with known languages
- `web/styles/tokens.css` — add `--code-*` token properties to all 5 theme blocks
- `web/styles/transcript.css` — add `.line.assistant code .hljs-*` rules
- `web/styles/workspace.css` — add `.hljs-*` rules scoped to the file viewer's `<pre>`
- `web/src/transcript/stream-render.ts` — no changes needed; the frozen/tail split already keeps open code blocks in the tail, so they re-render (and re-highlight) each frame naturally
- `web/src/transcript/stream-split.ts` — no changes; the cut scanner already tracks fences and never cuts inside a code block

**Verification**

1. `bunx tsc --noEmit` — no type errors
2. `bun run typecheck:web` — web code type-checks
3. `bun run lint` — ESLint passes
4. `bun test` — all existing tests pass
5. `bun run dev:web` — bundle builds successfully; `web/dist/app.js` contains `hljs-keyword` strings
6. Manual: code blocks in chat (TS, JSON, SQL, CSS/HTML) are highlighted; unsupported languages fall back to plain text; file viewer highlights known extensions; theme switching changes code colours; streaming code blocks re-highlight without glitches

**Decisions**

- **highlight.js** over hand-rolled regex: ~15 KB core + ~5 KB per language, 200+ languages available if we want to add more later, well-tested edge cases (nested templates, regexps, etc.)
- **Only 5 language packs** in the bundle: typescript, javascript (built-in), json, sql, css, xml. Any other language tag renders as plain text. Adding more is one import + one `registerLanguage` call.
- **marked renderer override** (not post-processing): cleaner than finding `code.language-*` elements in the DOM after `renderMarkdown`; the highlighting is part of the HTML string before DOMPurify runs
- **DOMPurify unchanged**: `<span class="hljs-keyword">` elements pass through its default sanitization (class attribute is allowed by default)
- **File viewer uses the same `hljs.highlight` API** as the chat renderer — no duplication
- **No terminal REPL changes**: the terminal's ANSI rendering (`src/output/markdown.ts`) stays as-is
- **No new CSS file**: rules go in the existing `transcript.css` (chat) and `workspace.css` (viewer)
- **No new module for language detection**: `highlightLang` is a 10-line function in `open-tabs.ts` alongside the existing `viewerMode`

**Further Considerations**

1. **Performance on very large files**: highlighting a 200 KB file will take a frame or two. If it becomes noticeable, gate to files under ~50 KB (check `file.text.length`). For chat code blocks, re-highlighting each frame during streaming is fine for blocks under ~100 lines; beyond that the tail re-render already costs as much as the highlighting.
2. **Line numbers in the file viewer**: not included in this plan ("extremely simple"), but if wanted later, highlight.js's output already works with a line-number gutter (a `<span>` per line, or a CSS counter on `::before` of each line). This would be a separate, small change.
3. **Adding more languages**: to add, e.g., Python or Rust, add the import + `registerLanguage` in `markdown.ts` and the extension mapping in `highlightLang`. No other changes needed.
