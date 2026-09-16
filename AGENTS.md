# Vise — Agent Instructions

A pnpm-workspaces monorepo: a **vanilla TypeScript backend** (raw Node `http`, no framework) and a **vanilla TypeScript frontend** (Vite, no framework). It's a local file browser/editor with an LLM panel that gives a model live, sandboxed read/write/shell access to the workspace. See [README](README.md) for setup and layout.

## Commands (run from repo root)

| Task                                           | Command                                                              |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| Install                                        | `pnpm install`                                                       |
| Dev (backend :3001 + frontend :5173, parallel) | `pnpm dev`                                                           |
| Build (all packages)                           | `pnpm build`                                                         |
| Typecheck (all packages)                       | `pnpm typecheck`                                                     |
| Test                                            | `pnpm test` (frontend only — Jest; backend has no test script)      |
| Lint                                            | `pnpm lint` (Biome: `biome check .`)                                 |
| Format                                          | `pnpm format` (Biome: `biome format --write .`)                      |

Run these automatically before/after changes; a change is not done until `pnpm typecheck` and `pnpm lint` pass (and `pnpm test` for anything touching `apps/frontend/src/components/{conversations,fileState}.ts`).

To run a single frontend test file or a name pattern: `pnpm --filter @vise/frontend exec jest src/components/conversations.test.ts` or `... jest -t "some test name"`.

## Architecture

### Backend (`apps/backend`) — layered, no framework

- `router.ts` — pure path matching (`:param`, trailing `*` → `params.rest`). No side effects.
- `http.ts` — `sendJson` (the only response writer).
- `errors.ts` — `AppError` + factories (`notFound`, `badRequest`, `forbidden`, `internal`) and `toResponse`.
- `context.ts` — `AppContext` (deps: `now`, `rootPath`, `fileWatcher`) injected into route factories.
- `fs.ts` — the single place all filesystem access passes through: `resolveWithinRoot` (must exist, follows symlinks, rejects escapes), `resolveForCreate` (parent must exist), `validatePath` (name vetting), `assertDoesNotExist`, `createDir`/`createFile` (create cores), `looksBinary` (NUL-byte sniff, first 8 KB), `mapFsError` (raw `fs` → `AppError`: ENOENT/ENOTDIR→404, EACCES/EPERM→403, EISDIR→400).
- `watch.ts` — `createFileWatcher(rootPath)`: a dependency-free recursive `fs.watch`-based watcher that debounces (100ms) bursty raw events into one `WatchEvent` per changed path and exposes `start`/`close`/`subscribe`. Falls back to a non-recursive root watch where recursive `fs.watch` isn't supported (Linux); Windows/macOS get the real recursive watch.
- `json.ts` — `readJsonBody`.
- `routes/*.ts` — one resource file per endpoint group; each exports a **named** factory (`healthRoutes`, `helloRoutes`, `echoRoutes`, `lsRoutes`, `fileRoutes`, `createRoutes`, `llmToolRoutes`, `watchRoutes`) returning `Route[]`.
- `app.ts` — composes `routeGroups` (the 8 factories), starts the file watcher, mounts the request loop (guards `/api/` prefix, body parsing, error → `toResponse`). `close()` calls `server.closeAllConnections()` before `server.close()` — an open `/api/watch` SSE stream is a long-lived connection that would otherwise keep the server (and the watcher teardown) from ever completing.
- `index.ts` — entry point; reads `PORT` (default 3001) and `ROOT_DIR`. `SIGINT`/`SIGTERM` trigger a clean `app.close()` so the watcher doesn't keep the event loop alive.

To add an endpoint: create/extend a `routes/*.ts` factory returning `Route[]`, then register it in `routeGroups` in `app.ts`. Do not bypass `sendJson` or hand-write `res` — throw `AppError`s and let `app.ts` map them.

### Frontend (`apps/frontend`) — vanilla TS + Vite

- `main.ts` — mounts `render` into `#app`.
- `render.ts` — builds the static shell (template string + DOM), then calls `setupFileViewer` and `setupLlm`.
- `api/client.ts` — **the only place that calls `fetch`/`EventSource`**. Typed wrappers (`health`, `listDir`, `getFile`, `putFile`, `deleteFile`, `createEntry`, `subscribeToChanges`, plus the LLM helpers `listLlmModels`, `sendLlmMessage`, `executeLlmTool`); each returns parsed data or throws a normalized `Error`. Holds the hardcoded `LLM_API_KEY` bearer token (dev-only, `127.0.0.1` proxy only).
- `dom.ts` — small DOM helpers (e.g. `makeButton`).
- `highlight.ts` — dependency-free, single-line syntax highlighter (no cross-line state, no language detection).
- `components/fileTree.ts` — the thin DOM controller for the tree/listing and the file viewer/editor: renders the listing, wires the context menu (new/delete via `contextMenu.ts` + `createDialog.ts`), owns expand/collapse state, the `beforeunload` dirty guard, and live-refresh from the watch SSE stream (see below). Delegates the editor's buffer/dirty/autosave logic to `fileState.ts`.
- `components/fileState.ts` — a DOM-free store for the editor's autosave lifecycle (buffer, `dirty` flag, debounced save timer, `flush`/`save`). Kept free of the DOM and of `api/client.ts` (the persist function is injected) so it's unit-testable in Node; see `fileState.test.ts`.
- `components/conversations.ts` — a DOM-free `ConversationStore`: owns the list of chat conversations (each with its own message history, model choice, and per-conversation `disabledTools`), persists them to `localStorage`, and migrates the old single-conversation format. Unit-tested in `conversations.test.ts`.
- `components/messageView.ts` — `MessageView`, a virtualized renderer for the chat log: only the blocks in/near the viewport are live DOM nodes (absolutely positioned inside a full-height spacer), so scrolling a long conversation stays smooth.
- `components/llm.ts` — the LLM panel's DOM controller: wires the conversation/model dropdowns, the tool enable/disable checklist, the send loop, and context-usage display, using the stores/view above.
- `components/contextMenu.ts`, `components/createDialog.ts` — shared right-click menu and "create file/dir" modal.
- `llm/tools.ts` — OpenAI-style tool **definitions** (`llmToolDefinitions`) sent with each chat request.
- `styles.css` imports per-area CSS in `styles/`.

Views call functions from `api/client.ts` — never `fetch`/`EventSource` directly.

The Vite dev server proxies `/api` → `localhost:3001` and `/llm` → `localhost:8080` (see `vite.config.ts`).

### Live file-tree updates (`GET /api/watch` + `subscribeToChanges`)

`routes/watch.ts` exposes the app-owned `fileWatcher` as an SSE stream (`text/event-stream`, one `data: <WatchEvent JSON>\n\n` per debounced change). The frontend's `subscribeToChanges` wraps it in an `EventSource` (auto-reconnecting) and `fileTree.ts` uses it to: refresh the root and every expanded directory, and reload the open file *only if its buffer is clean* (an in-progress edit is never clobbered — if the open file changed on disk while dirty, the title is annotated "(out of date)" instead). Refreshes are debounced an additional 80ms client-side to coalesce bursts.

### LLM panel (`apps/frontend/src/components/llm.ts` + `routes/llm.ts`)

A chat panel that talks to an **OpenAI-compatible proxy** (llama.cpp at `:8080`) through the Vite `/llm` proxy (which rewrites `/llm/*` → `/*`). Conversations are independent, persisted in `localStorage`, and listed in a dropdown (New/Delete/switch). The flow is a client-side tool loop:

1. `sendLlmMessage` posts messages + `llmToolDefinitions` to `/llm/v1/chat/completions`.
2. If the reply contains `tool_calls`, the panel calls `executeLlmTool` for each → `POST /api/llm/tool` on the **backend**.
3. The backend runs the tool (`routes/llm.ts`), returns a text result, and the loop feeds it back as a `tool` message until the model produces plain text (capped at `MAX_TOOL_TURNS = 5` iterations in `llm.ts`).

**Tools** (defined in `llm/tools.ts`, handled in `routes/llm.ts`, named in `packages/shared`'s `LLM_TOOL_NAMES`): `list_directory`, `find_files` (regex on base name via `git ls-files --cached --others --exclude-standard`, so it's git-ignore-aware; capped at 500 matches), `read_file` (1-based, `start_line` inclusive/`end_line` exclusive, ≤300 lines/call), `edit_file` (replace a ≤300-line range in an existing file; `end_line === start_line` inserts, an empty `content` deletes the range), `create_directory`, `create_file`, `delete_file`, `delete_directory` (both permanent, root itself is rejected), `run_command` (spawns a **PowerShell** command in the workspace root; 30s timeout, 1MB combined output cap, at most one command in flight at a time, and on timeout kills the whole process tree via `taskkill /T /F` since plain `child.kill()` only signals the top-level process on Windows), and `create_subagent` (see below). All tools are root-scoped through `fs.ts`'s resolvers. Tool results are always plain strings; backend errors resolve to `200` + an `Error: …` string so the model can read and adapt rather than the loop crashing.

**`create_subagent` is the one tool the backend never executes.** Every other tool call is forwarded to `POST /api/llm/tool`; `create_subagent` is intercepted client-side in `llm.ts` (`resolveToolCall`/`runSubagent`) because it needs to run its own nested chat-completion loop, which only the panel can do (it alone talks to the LLM proxy). `runSubagent` gives the helper a fresh message history (just the task text, not the parent conversation), the same tools the parent has minus `create_subagent` itself (so nesting stops at one level) and minus whatever the parent has disabled, and a bounded loop (`SUBAGENT_MAX_TOOL_TURNS = 5`). Nothing about the subagent's run is persisted: the parent conversation's store only gets the `tool_calls`/`tool` message pair like any other tool, with the subagent's final text as the result. For the live session, `MessageView.appendSubagentResult` renders the run as a collapsed `<details>` block (task, its own tool-call/tool-result trace, then its result) so it's inspectable without cluttering the main transcript; after a reload only the plain result survives (it's an ordinary tool message), same as any other tool. The backend still carries a `create_subagent` entry in `routes/llm.ts`'s `tools` record purely to satisfy the `Record<LlmToolName, LlmToolHandler>` exhaustiveness check — it throws if ever actually reached, which would mean the client-side interception was bypassed.

**Per-conversation tool disabling**: the panel renders a checklist of all tools; unchecking one adds it to that conversation's `disabledTools`. A disabled tool's *definition* is still sent to the model (so the prompt prefix — and any KV cache — is unchanged); instead the system prompt gets a note listing disabled tools, and any call to one is short-circuited client-side to a fixed "disabled" string rather than reaching the backend.

**Context compaction**: `llm.ts` tracks prompt tokens per conversation against the model's context window (from `/llm/v1/models`). Once the last call used ≥80% of the window (`COMPACT_THRESHOLD`), the *next* turn first asks the model to summarize the conversation, appends the summary as a `compaction`-flagged message, and from then on `buildMessages` sends only that summary plus everything after it — the underlying message array stays append-only (nothing is ever deleted), only the outgoing prompt is truncated.

**Adding a tool** requires the shared `LLM_TOOL_NAMES` entry, a definition in `llm/tools.ts`, and a handler in the `tools` record in `routes/llm.ts` (see [Shared contract](#shared-contract-packagesshared)). Neither side hardcodes tool names beyond that shared list.

A bearer token (`LLM_API_KEY`) is hardcoded in `api/client.ts` — a local-use key, since the proxy only forwards to `127.0.0.1`.

### Shared contract (`packages/shared`)

`packages/shared` is the single source of truth for cross-app shapes. It exports the `LLM_TOOL_NAMES` const array and the derived `LlmToolName` type. Both apps consume it **type-only** (`import type`), so the backend's zero-runtime-deps invariant holds (the type import erases the runtime const). It has **no build step** — `main`/`types` point straight at `./src/index.ts`.

**Adding an LLM tool touches three files:** the `LLM_TOOL_NAMES` const here, a definition in `llm/tools.ts`, and a handler in the `tools` record in `routes/llm.ts`. A misspelled tool name is a compile error on both sides.

## Conventions

- **TypeScript strict** everywhere (`strict: true`, ES2022, ESM). Backend uses `.js` extensions in relative imports (ESM); frontend likewise.
- **No dependencies by design** — backend has zero runtime deps; frontend only Vite + TypeScript (plus Jest/ts-jest as dev deps for the two DOM-free store test suites). Do not add a framework or HTTP library without asking.
- **Formatting is owned by Biome** (repo root `biome.json`): 2-space indent, double quotes, semicolons, 80-col lines, LF endings. Don't fight it; run `pnpm format`.
- **Path safety is non-negotiable**: every filesystem access in a route or LLM tool must go through `resolveWithinRoot` (or `resolveForCreate` for creates). Never join `rootPath` with user/model input directly — this is the core invariant of the app.
- **Binary / size guards**: file preview and writes are capped at 1 MB (`MAX_BYTES`) and reject files with a NUL byte in the first 8 KB (`looksBinary` in `fs.ts`). Keep these guards when touching file routes or the `read_file`/`edit_file` LLM tools.
- **Error mapping**: raw `fs` errors are mapped via `mapFsError` (in `fs.ts`) so ENOENT/ENOTDIR→404, EACCES/EPERM→403, EISDIR→400. Re-throw existing `AppError`s unchanged.
- **DOM-free stores are unit-tested; DOM controllers are not.** `conversations.ts` and `fileState.ts` take their side effects (persist/network) as injected callbacks specifically so they can run under Jest in Node. If you add similar stateful logic, prefer the same split rather than burying it in a DOM controller like `fileTree.ts`/`llm.ts`.

## Pitfalls

- **No CI** — there is no `.github` workflow. `pnpm typecheck`, `pnpm lint`, and `pnpm test` are run manually/by the agent, not automatically.
- **Tests only cover two DOM-free stores** (`fileState.ts`, `conversations.ts`) via Jest/ts-jest in the frontend (`apps/frontend/jest.config.js`). There are no DOM/e2e tests and the backend has no test script at all.
- Backend `dev` runs via `tsx watch`; it does **not** rebuild `dist/`. Production runs `node dist/index.js` after `pnpm build` (frontend build is `tsc --noEmit` + `vite build`).
- `ROOT_DIR` defaults to a hardcoded Windows path in `index.ts` — it must be set explicitly for anything other than the author's machine. `PORT` (default 3001) is the only other env var read.
- `LLM_API_KEY` is hardcoded in `api/client.ts` and baked into the bundle — fine for the single-user local tool, but it is a committed secret; move it to a gitignored `.env` + `import.meta.env.VITE_*` before sharing the repo.
- The `run_command` LLM tool runs **arbitrary PowerShell in the workspace root with no allowlist**, gated only by a 30s timeout and single in-flight execution. This is by design for a trusted single local user talking to their own local model — treat it as a real risk surface if the LLM proxy, the backend port, or the model's tool access is ever exposed beyond `127.0.0.1`. It's also Windows-specific (spawns `powershell.exe`, kills via `taskkill`).
- The `/llm` proxy exists only in `vite.config.ts` (dev server) — the built SPA has no production path to the LLM.
- The router only matches under `/api/`; anything else gets a 404 before route matching (see `app.ts`).
- Recursive `fs.watch` isn't available on all platforms (notably Linux); `watch.ts` falls back to a non-recursive root watch there, so nested changes on Linux may not trigger a live refresh the way they do on Windows/macOS.
- Biome ignores `dist/`, `node_modules/`, and `pnpm-lock.yaml` via `biome.json`/`.gitignore` — don't expect lint coverage on build output.
