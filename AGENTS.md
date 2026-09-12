# AGENTS.md

Guidance for AI coding agents working in this repository.

> **Start here.** For deeper architecture context — design invariants, known
> potential problems, and the "future work" roadmap — read the canonical
> architecture doc in repository memory at `/memories/repo/architecture.md`
> (use the `memory` tool with `command: "view"`). It describes where the code
> is _heading_, not just what it is today; keep it ahead of the code. This file
> (AGENTS.md) is the working guide; that doc is the reference.

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
- **Network layer:** `src/api.js` owns **all** `fetch('/api/*')` calls. It exports `fetchEntries(path)`, `fetchFileContent(path)`, `sendChat(messages, conversationId, notesSnapshot, profileInstructions, onDelta, onReasoning, onFileEdit)` — the chat call consumes the SSE stream from the backend and forwards deltas to the three callbacks — `fetchNotesSnapshot()` which returns a fresh notes snapshot text, plus the profile CRUD calls `fetchProfiles()`, `saveProfile(name, instructions)`, and `deleteProfile(name)`. Keep network I/O here, not in behavior modules.
- **Shared state:** `src/state.js` is a tiny module (`setOpenFilePath`/`getOpenFilePath`) holding the path of the file currently shown in the viewer. Sibling behavior modules read/write it instead of reading each other's DOM. It is a leaf module.
- **Behavior modules:** each feature is a `setup*(appEl)` module that attaches event listeners (delegation on `appEl` for tree/file viewer; a direct `submit` listener on the form for chat) and builds its own DOM via private render helpers:
  - `src/listing.js` — `setupTree`: expand/collapse the directory tree, lazy-loading children.
  - `src/fileViewer.js` — `setupFileViewer`: click a file → fetch content → render with line numbers; also listens for the `file-edit` CustomEvent and animates the new content in line-by-line when the open file was edited.
  - `src/chat.js` — `setupChat`: submit the form → send the conversation (streaming) → append the reply; dispatches a `file-edit` CustomEvent when the model writes a file, and injects a `[Context: ...]` note about the currently-open file. Manages the active conversation's live working set (`sent`/`display`/`notesSnapshot`/`profileName`/`profileInstructions`) and the dropdown DOM; delegates multi-conversation state, persistence, migration, and switching to `src/conversations.js`. Clearing starts a **new** conversation (pushes a fresh entry) rather than wiping all history. A dropdown button (`.chat-convo-dropdown`) in the header lists all conversations by title (derived from the first user message, truncated to 40 chars); clicking an entry switches `currentIndex`, restores live state, and re-renders. The `notesSnapshot` is fetched lazily on first send of a new conversation via `fetchNotesSnapshot()` and persisted alongside the conversation so a resumed conversation after a backend restart reuses the same snapshot. The selected profile's instructions are **frozen** on the conversation's first send (exactly like the notes snapshot) into `profileName`/`profileInstructions`, persisted with the conversation, and re-sent on every request; `restore` re-syncs the profile dropdown via `setSelectedProfile` so a resumed conversation shows the profile it started with. The `conversationId` is reset on Clear (new conversation gets a fresh ID).
  - `src/conversations.js` — DOM-less leaf module owning the multi-conversation collection: the `conversations` array, `currentIndex`, `STORAGE_KEY`, `titleFor`, the `load()` migration ladder (current → bare-array → legacy single-conversation shapes), `addConversation(id)`, `setActiveIndex(idx)`, `getCurrentIndex()`, and `saveActive(snapshot)` — the single persistence entry point that syncs the live working set into the active slot and serializes to localStorage under `vise-chat` as `{ conversations, currentIndex }`. Each conversation carries `profileName` (the profile it started with, for UI re-sync) and `profileInstructions` (that profile's frozen instructions, sent to the backend). `chat.js` imports this module for data; it is a leaf (no DOM, no imports of behavior modules or `main.js`).
  - `src/profiles.js` — `setupProfiles`: the "Profiles" dropdown in the chat header — a selector for the user-defined instruction profile (the "custom agent" persona) plus an in-app editor to create/delete profiles. Profiles are stored **on the backend** (like the notes store). The "No instructions" option is a virtual default (no profile system message sent). Exports `getSelectedProfileName()`, `getSelectedProfileInstructions()` (read by `chat.js` at send time to freeze the choice), and `setSelectedProfile(name, instructions)` (called by `chat.js` when restoring a conversation). Wires the shared `setupKeyboardMenu` (like the tools/conversation dropdowns). Owns its own DOM, fetch, and open/close state; reads no conversation state.
  - `src/dividers.js` — `setupDividers`: makes the `.divider` elements mouse-draggable and keyboard-resizable, writing `--tree-width`/`--chat-width` CSS custom properties onto `.layout` (clamped).
- **Dependency direction:** one-way only — `main.js → {render, listing, fileViewer, chat, dividers, tools, profiles}`; `listing → {render, api}`; `fileViewer → {api, render, state}`; `chat → {api, render, state, conversations, menu, profiles}`; `tools → {api, menu}`; `profiles → {api, menu}`; `dividers → {}` (no local imports). `api.js`, `render.js`, `state.js`, `conversations.js`, and `menu.js` (shared keyboard-menu behavior for the header dropdowns) are leaves and must not import behavior modules or `main.js`. (`profiles.js` imports only `api.js` and `menu.js`; `chat.js` imports `profiles.js` for the frozen profile choice, so the edge is one-way.)
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
  - `POST /api/chat { messages, conversationId, notesSnapshot, profileInstructions }` — **SSE stream** of LLM events (logic in `chat.js`). The frontend supplies a `conversationId` (stable per conversation), a `notesSnapshot` (the snapshot text it stored at conversation start) so a resumed conversation after a backend restart reuses the same snapshot the model's prior replies saw, and a `profileInstructions` block (the frozen instructions of the profile the conversation started with). The server injects the notes snapshot and, when non-empty, the profile instructions as system messages when building the conversation.
  - `GET /api/notes-snapshot` — returns `{ snapshot: string }` — a fresh notes snapshot from the current store, used by the frontend to seed its stored snapshot when a conversation starts.
  - `GET /api/profiles` — returns `{ profiles: [{ name, instructions }] }` — the user's stored profiles (logic in `profiles.js`).
  - `POST /api/profiles { name, instructions }` — adds or updates a profile by name (case-insensitive), returns `{ profile }`.
  - `DELETE /api/profiles?name=X` — removes a profile by name (404 if it does not exist).
- **Path safety:** `pathGuard.js` exports `resolveWithin(root, rel)` — the single path-traversal guard used by both `api.js` and `static.js`. Use it for any new path-based route.
- **LLM proxy + tools:** `chat.js` calls an OpenAI-compatible endpoint (env vars `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, with hardcoded defaults) and runs a **function-calling loop** (capped at `MAX_TOOL_ROUNDS`): the model may call tools to inspect or edit the repository. Tools live in `tools.js` — each tool's _definition_ (OpenAI function schema), _executor_, and a short `summary(args)` (the human-readable detail, e.g. the path, command, pattern, or title, shown in the chat's tool badge) are co-located in one registry entry, so adding a tool is a single-file change. `api.js` passes the `TOOLS` registry to `chat.js`; `chat.js` stays tool-agnostic — it calls each tool's `summary` and forwards the result in the `done` SSE event's `toolCalls` (each `{ name, label, icon, detail, args }`). Current tools: `take_note` (stores a titled note in the persistent notes store, upserting by title case-insensitively), `update_note` (performs a literal exact-match substring replacement in a note's content by title; the previous string must appear exactly once), `delete_note` (removes a note from the store by title, case-insensitively), and `recall_notes` (lists or regex-searches the persistent notes store), `create_function` (defines a named JS function that later `eval` calls can use by name), `list_eval_functions` (lists every function callable inside an `eval` expression — built-ins plus any `create_function` definitions), and `eval` (evaluates a JS expression in a sandbox with a 2s timeout; supports top-level `await`; exposes the built-in file I/O and directory functions `listDirectory(path)` (directory listing, `\"\"` for the root), `readFile(path)`, `writeFile(path, content)`, `editFile(path, content)`, `createDirectory(path)`, plus the async `runPowershell(command)` and `searchFiles(pattern)` functions, and any `create_function` definitions). File I/O, directory operations, process execution (`runPowershell`), and file search (`searchFiles`) are not standalone tools: they are built-in functions inside `eval` (defined in `EVAL_BUILTINS` in `evalTools.js`), listed under "eval functions" in the UI via `/api/eval-functions`, and any file write the `eval` tool performs is recorded in `evalTools.js`'s module-level `fileEdits` array and drained by `chat.js` via `drainFileEdits()` so the UI can live-update the open file.
- **Notes store:** `notes.js` is a leaf module owning all note I/O. Notes are stored as a JSON array in `~/.vise-notes/notes.json` (outside the repository, in the user's home directory). Each note is `{ title, content, updatedAt }`. `upsertNote(title, content)` updates in place if the title already exists (case-insensitive) or appends a new note. `updateNote(title, oldString, newString)` performs a literal exact-match replacement of `oldString` with `newString` in the note's content, failing if the note doesn't exist or `oldString` is ambiguous (more than one match) or absent. `deleteNote(title)` removes a note by title (case-insensitive), failing if the note doesn't exist. `searchNotes(re)` filters by title or content against a case-insensitive regex. `listNotes()` returns all notes sorted by title. `loadNotes()` and `saveNotes(notes)` handle file I/O.
- **Profiles store:** `profiles.js` is a leaf module owning all profile I/O. Profiles are stored as a JSON array in `~/.vise-profiles/profiles.json` (outside the repository). Each profile is `{ name, instructions }`. `listProfiles()` returns all profiles sorted by name (case-insensitive). `upsertProfile(name, instructions)` updates in place if the name already exists (case-insensitive) or appends. `deleteProfile(name)` removes a profile by name, failing if it does not exist. `loadProfiles()` / `saveProfiles(profiles)` handle file I/O. Profiles are the "custom agent" persona: the frontend freezes the selected profile's instructions per conversation (like the notes snapshot) and the server injects them as a system message.
- **Per-domain tool modules:** as the tool registry grows, tools are split into per-domain modules (e.g. `notesTools.js` for the note tools) that export their tool registry entries. `tools.js` imports and re-exports them in `TOOLS` so the LLM sees a single registry. Each per-domain module is a leaf that imports its own domain's I/O module (e.g. `notesTools.js` → `notes.js`) but never `tools.js` or `api.js`.
- **Notes context:** `notesContext.js` is a leaf that builds the per-conversation notes snapshot injected as a system message. `getNotesContext(conversationId, storedSnapshot)` returns the snapshot for a conversation: if the Map already has an entry for `conversationId`, it returns that; if not and `storedSnapshot` is provided, it uses that (seeding the Map); otherwise it builds a fresh one. When `conversationId` is absent, a fresh uncached snapshot is returned each call. `buildSnapshot()` is also exported — `api.js` uses it for the `GET /api/notes-snapshot` endpoint so the frontend can seed its stored snapshot at conversation start. The snapshot is frozen per conversation and is not affected by note changes made via tools during that conversation.
- **SSE streaming:** the chat response is streamed as Server-Sent Events. `api.js` (server) emits the events `delta`, `reasoning`, `file_edit`, `done`, `error`; the frontend `src/api.js` mirrors these event names when parsing the stream. Keep the two sides in sync if you change event names.
- **Static serving:** `static.js` serves files with correct MIME types and guards against path traversal.
- **Dependency direction:** one-way only — `index.js → {api, static}`; `api.js → {listing, pathGuard, chat, notesContext, tools, profiles}`; `tools.js → {notesTools, evalTools}`; `notesTools.js → notes`; `evalTools.js → {listing, pathGuard, processTools}`; `processTools.js → {listing}`; `notesContext.js → notes`; `static.js → pathGuard`. Leaf modules (`listing.js`, `pathGuard.js`, `chat.js`, `tools.js`, `notes.js`, `notesTools.js`, `evalTools.js`, `processTools.js`, `notesContext.js`, `profiles.js`) must not import `index.js` or `api.js`.
- **No dependencies:** use Node built-ins (`node:http`, `node:fs/promises`, `node:path`, `node:url`). Do not add Express or other frameworks without explicit request.

## Pitfalls

- Do not add a framework or build tool without explicit request — this is intentionally plain Vite + vanilla JS + Node `http`.
- File I/O, directory, process, and search are **`eval` built-ins, not standalone LLM tools.** Do not add `read_file`/`write_file`/`list_directory`/`run_powershell`/`search_files` (or similar) as entries in the `TOOLS` registry — they exist only as built-in functions inside the `eval` sandbox (`EVAL_BUILTINS` in `evalTools.js`). They are listed in the UI under "eval functions" via `/api/eval-functions`, not in the tool list. If you find yourself adding a tool that just wraps one of these, fold it into `eval` instead.
- The backend lists the **repository root** (`repoRoot` in `listing.js`, three levels up from `apps/server/`), not the CWD. All `/api/listing` and `/api/file` paths are resolved relative to that root and must stay within it.
- `public/` assets are not processed by Vite; use `src/assets/` imports when you need bundling/hashing.
- CSS uses native nesting — keep it consistent; do not introduce a CSS preprocessor.
- Production serving requires the frontend to be built first (`npm run build`) so `apps/web/dist` exists.
- The LLM API key has a hardcoded default in `apps/server/chat.js`; override with `LLM_API_KEY` in production.
