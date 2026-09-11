# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

A **frontend + backend** monorepo (npm workspaces) using **vanilla JavaScript** (no framework) and **Node's built-in `http`** module (no Express).

The app is a file browser: it renders a directory tree, shows file contents on click, and provides a chat box that proxies to an LLM.

- **`apps/web`** — Vite frontend. Renders a single-page UI (tree + file viewer + chat) that fetches data from the backend.
- **`apps/server`** — Node backend. Serves a JSON API (`/api/listing`, `/api/file`, `/api/chat`) and, in production, serves the built frontend.

## Commands

Run from the repo root (scripts use npm workspaces):

| Task                         | Command            |
| ---------------------------- | ------------------ |
| Dev (frontend + backend)     | `npm run dev`      |
| Production build (frontend)  | `npm run build`    |
| Start backend (serves build) | `npm start`        |
| Preview frontend build       | `npm run preview`  |
| Lint (CPD, all workspaces)   | `npm run lint:all` |

Per-workspace: `npm run dev -w web`, `npm run dev -w server`, etc.

There is **no test runner or formatter** configured. `npm run lint:all` runs **PMD CPD** (copy-paste detection) per workspace — keep code DRY so it stays clean. Verify UI changes by running the dev server and checking the browser.

## Architecture & Conventions

### Monorepo layout

- Root `package.json` declares `workspaces: ["apps/web", "apps/server"]` and only orchestration scripts.
- Each app owns its own `package.json`, dependencies, and lint scripts.
- **ES modules** throughout (`"type": "module"`). Use `import`/`export`, not CommonJS.

### Frontend (`apps/web`)

- **Entry point:** `index.html` loads `/src/main.js` as a module.
- **Composition root:** `src/main.js` is a thin wiring module — it imports the render layer and the behavior modules, then calls them (`renderApp`, `setupTree`, `setupFileViewer`, `setupChat`, `setupDividers`). Keep it small; do not add rendering or feature logic here.
- **Rendering:** `src/render.js` is the pure DOM-building layer (no imports). It exports `renderApp(appEl)` (page shell), `renderTree(el, entries, path)`, `renderChildren(li, entries, path)`, `renderMessages(container, messages)` (chat transcript), and `renderLines(codeEl, text)` (file content with line numbers), all built via `createElement`/`replaceChildren`. Add new markup here, not in `main.js`.
- **Network layer:** `src/api.js` owns **all** `fetch('/api/*')` calls. It exports `fetchEntries(path)`, `fetchFileContent(path)`, and `sendChat(messages, onDelta, onReasoning, onFileEdit)` — the chat call consumes the SSE stream from the backend and forwards deltas to the three callbacks. Keep network I/O here, not in behavior modules.
- **Shared state:** `src/state.js` is a tiny module (`setOpenFilePath`/`getOpenFilePath`) holding the path of the file currently shown in the viewer. Sibling behavior modules read/write it instead of reading each other's DOM. It is a leaf module.
- **Behavior modules:** each feature is a `setup*(appEl)` module that attaches event listeners (delegation on `appEl` for tree/file viewer; a direct `submit` listener on the form for chat) and builds its own DOM via private render helpers:
  - `src/listing.js` — `setupTree`: expand/collapse the directory tree, lazy-loading children.
  - `src/fileViewer.js` — `setupFileViewer`: click a file → fetch content → render with line numbers; also listens for the `file-edit` CustomEvent and animates the new content in line-by-line when the open file was edited.
  - `src/chat.js` — `setupChat`: submit the form → send the conversation (streaming) → append the reply; dispatches a `file-edit` CustomEvent when the model writes a file, and injects a `[Context: ...]` note about the currently-open file.
  - `src/dividers.js` — `setupDividers`: makes the `.divider` elements mouse-draggable and keyboard-resizable, writing `--tree-width`/`--chat-width` CSS custom properties onto `.layout` (clamped).
- **Dependency direction:** one-way only — `main.js → {render, listing, fileViewer, chat, dividers}`; `listing → {render, api}`; `fileViewer/chat → {api, render, state}`; `dividers → {}` (no local imports). `api.js`, `render.js`, and `state.js` are leaves and must not import behavior modules or `main.js`.
- **API access:** the frontend calls **relative** `/api/*` paths. In dev, Vite proxies `/api` to the backend (see `vite.config.js`); in production the backend serves both. Do not hardcode backend host/port in frontend code.
- **Styling:** `src/style.css` uses **native CSS nesting**, CSS custom properties (design tokens in `:root`, including `--tree-width`/`--chat-width` for the resizable columns), and `prefers-color-scheme` for dark mode. Follow the existing token-based approach (`var(--accent)`, etc.) rather than hardcoding colors.
- **Static assets:**
  - `public/` — served as-is at the site root (e.g. `/favicon.svg`). Reference with an absolute `/` path.
  - `src/assets/` — if you add JS-imported assets here, Vite processes/hashes them (this folder is not yet present).

### Backend (`apps/server`)

- **Entry point:** `index.js` creates the `http` server and routes requests. Keep it thin.
- **Routing:** requests starting with `/api/` go to `api.js`; everything else is served as static files from the frontend build (`apps/web/dist`) via `static.js`.
- **API handlers:** `api.js` maps routes to handlers:
  - `GET /api/listing[?path=rel]` — directory entries (logic in `listing.js`).
  - `GET /api/file?path=rel` — file text content (logic in `listing.js`).
  - `POST /api/chat { messages }` — **SSE stream** of LLM events (logic in `chat.js`).
- **Path safety:** `pathGuard.js` exports `resolveWithin(root, rel)` — the single path-traversal guard used by both `api.js` and `static.js`. Use it for any new path-based route.
- **LLM proxy + tools:** `chat.js` calls an OpenAI-compatible endpoint (env vars `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, with hardcoded defaults) and runs a **function-calling loop** (capped at `MAX_TOOL_ROUNDS`): the model may call tools to inspect or edit the repository. Tools live in `tools.js` — each tool's _definition_ (OpenAI function schema), _executor_, and a short `summary(args)` (the human-readable detail, e.g. the path, command, pattern, or title, shown in the chat's tool badge) are co-located in one registry entry, so adding a tool is a single-file change. `api.js` passes the `TOOLS` registry to `chat.js`; `chat.js` stays tool-agnostic — it calls each tool's `summary` and forwards the result in the `done` SSE event's `toolCalls` (each `{ name, label, icon, detail, args }`). Current tools: `list_directory`, `read_file`, `create_file`, `create_directory`, `edit_file` (the `writesFile` ones emit file-edit events so the UI can live-update the open file), `run_powershell` (runs a PowerShell command via `pwsh` in the repo root and returns its output, exit code, or a timeout/spawn-failure note), `search_files` (regex search over file names via `git ls-files -co -z --exclude-standard`, so results are exactly the files not ignored by `.gitignore`, matched case-insensitively against each file's relative path), `take_note` (stores a titled note in the persistent notes store, upserting by title case-insensitively), and `recall_notes` (lists or regex-searches the persistent notes store).
- **Notes store:** `notes.js` is a leaf module owning all note I/O. Notes are stored as a JSON array in `~/.vise-notes/notes.json` (outside the repository, in the user's home directory). Each note is `{ title, content, updatedAt }`. `upsertNote(title, content)` updates in place if the title already exists (case-insensitive) or appends a new note. `searchNotes(re)` filters by title or content against a case-insensitive regex. `listNotes()` returns all notes sorted by title. `loadNotes()` and `saveNotes(notes)` handle file I/O.
- **Per-domain tool modules:** as the tool registry grows, tools are split into per-domain modules (e.g. `notesTools.js` for the note tools) that export their tool registry entries. `tools.js` imports and re-exports them in `TOOLS` so the LLM sees a single registry. Each per-domain module is a leaf that imports its own domain's I/O module (e.g. `notesTools.js` → `notes.js`) but never `tools.js` or `api.js`.
- **SSE streaming:** the chat response is streamed as Server-Sent Events. `api.js` (server) emits the events `delta`, `reasoning`, `file_edit`, `done`, `error`; the frontend `src/api.js` mirrors these event names when parsing the stream. Keep the two sides in sync if you change event names.
- **Static serving:** `static.js` serves files with correct MIME types and guards against path traversal.
- **Dependency direction:** one-way only — `index.js → {api, static}`; `api.js → {listing, pathGuard, chat, tools}`; `tools.js → {listing, pathGuard, notesTools}`; `notesTools.js → notes`; `static.js → pathGuard`. Leaf modules (`listing.js`, `pathGuard.js`, `chat.js`, `tools.js`, `notes.js`, `notesTools.js`) must not import `index.js` or `api.js`.
- **No dependencies:** use Node built-ins (`node:http`, `node:fs/promises`, `node:path`, `node:url`). Do not add Express or other frameworks without explicit request.

## Pitfalls

- Do not add a framework or build tool without explicit request — this is intentionally plain Vite + vanilla JS + Node `http`.
- The backend lists the **repository root** (`repoRoot` in `listing.js`, three levels up from `apps/server/`), not the CWD. All `/api/listing` and `/api/file` paths are resolved relative to that root and must stay within it.
- `public/` assets are not processed by Vite; use `src/assets/` imports when you need bundling/hashing.
- CSS uses native nesting — keep it consistent; do not introduce a CSS preprocessor.
- Production serving requires the frontend to be built first (`npm run build`) so `apps/web/dist` exists.
- The LLM API key has a hardcoded default in `apps/server/chat.js`; override with `LLM_API_KEY` in production.
