# Vise — Agent Instructions

A pnpm-workspaces monorepo: a **vanilla TypeScript backend** (raw Node `http`, no framework) and a **vanilla TypeScript frontend** (Vite, no framework). See [README](README.md) for setup and layout.

## Commands (run from repo root)

| Task                                           | Command                                         |
| ---------------------------------------------- | ----------------------------------------------- |
| Install                                        | `pnpm install`                                  |
| Dev (backend :3001 + frontend :5173, parallel) | `pnpm dev`                                      |
| Build (all packages)                           | `pnpm build`                                    |
| Typecheck (all packages)                       | `pnpm typecheck`                                |
| Lint                                           | `pnpm lint` (Biome: `biome check .`)            |
| Format                                         | `pnpm format` (Biome: `biome format --write .`) |

Run these automatically before/after changes; a change is not done until `pnpm typecheck` and `pnpm lint` pass.

## Architecture

### Backend (`apps/backend`) — layered, no framework

- `router.ts` — pure path matching (`:param`, trailing `*` → `params.rest`). No side effects.
- `http.ts` — `sendJson` (the only response writer).
- `errors.ts` — `AppError` + factories (`notFound`, `badRequest`, `forbidden`, `internal`) and `toResponse`.
- `context.ts` — `AppContext` (deps: `now`, `rootPath`) injected into route factories.
- `fs.ts` — path sandboxing: `resolveWithinRoot` (must exist) and `resolveForCreate` (parent must exist).
- `json.ts` — `readJsonBody`.
- `routes/*.ts` — each exports a `routeFactory(ctx): Route[]`.
- `app.ts` — composes route groups, mounts the request loop (guards `/api/` prefix, body parsing, error → `toResponse`).
- `index.ts` — entry point; reads `PORT` (default 3001) and `ROOT_DIR`.

To add an endpoint: create/extend a `routes/*.ts` factory returning `Route[]`, then register it in `routeGroups` in `app.ts`. Do not bypass `sendJson` or hand-write `res` — throw `AppError`s and let `app.ts` map them.

### Frontend (`apps/frontend`) — vanilla TS + Vite

- `main.ts` — mounts `render` into `#app`.
- `render.ts` — builds UI (template string + DOM), wires events.
- `api/client.ts` — **the only place that calls `fetch`**. Typed wrappers (`health`, `listDir`, `getFile`, `putFile`, `deleteFile`, `createEntry`); each returns parsed data or throws a normalized `Error`.
- `dom.ts` — small DOM helpers (e.g. `makeButton`).
- `highlight.ts` — dependency-free, single-line syntax highlighter (no cross-line state, no language detection).
- `components/` — `contextMenu.ts`, `createDialog.ts`, `llm.ts` (the LLM panel, wired in from `render.ts`).
- `llm/tools.ts` — OpenAI-style tool **definitions** (`llmToolDefinitions`) sent with each chat request.
- `styles.css` imports per-area CSS in `styles/`.

Views call functions from `api/client.ts` — never `fetch` directly.

The Vite dev server proxies `/api` → `localhost:3001` and `/llm` → `localhost:8080` (see `vite.config.ts`).

### LLM panel (`apps/frontend/src/components/llm.ts` + `routes/llm.ts`)

A chat panel that talks to an **OpenAI-compatible proxy** (llama.cpp at `:8080`) through the Vite `/llm` proxy (which rewrites `/llm/*` → `/*`). The flow is a client-side tool loop:

1. `sendLlmMessage` posts messages + `llmToolDefinitions` to `/llm/v1/chat/completions`.
2. If the reply contains `tool_calls`, the panel calls `executeLlmTool` for each → `POST /api/llm/tool` on the **backend**.
3. The backend runs the tool (`routes/llm.ts`: `list_directory`, `read_file`), returns a text result, and the loop feeds it back as a `tool` message until the model produces plain text.

**Adding a tool = one definition in `llm/tools.ts` + one handler in `routes/llm.ts`.** Neither side hardcodes tool names beyond that shared list. Tool results are always plain strings; backend errors are resolved to `200` + an `Error: …` string so the model can read and adapt rather than the loop crashing.

A bearer token (`LLM_API_KEY`) is hardcoded in `api/client.ts` — a local-use key, since the proxy only forwards to `127.0.0.1`.

## Conventions

- **TypeScript strict** everywhere (`strict: true`, ES2022, ESM). Backend uses `.js` extensions in relative imports (ESM); frontend likewise.
- **No dependencies by design** — backend has zero runtime deps; frontend only Vite + TypeScript. Do not add a framework or HTTP library without asking.
- **Formatting is owned by Biome** (repo root `biome.json`): 2-space indent, double quotes, semicolons, 80-col lines, LF endings. Don't fight it; run `pnpm format`.
- **Path safety is non-negotiable**: every filesystem access in a route must go through `resolveWithinRoot` (or `resolveForCreate` for creates). Never join `rootPath` with user input directly — this is the core invariant of the app.
- **Binary / size guards**: file preview is capped at 1 MB (`MAX_BYTES` in `routes/file.ts`) and rejects files with a NUL byte in the first 8 KB. Keep these guards when touching file routes.
- **Error mapping**: map raw `fs` errors via `mapFsError` (in `routes/file.ts`) so ENOENT→404, EACCES/EPERM→403, EISDIR→400. Re-throw existing `AppError`s unchanged.

## Pitfalls

- Backend `dev` runs via `tsx watch`; it does **not** rebuild `dist/`. Production runs `node dist/index.js` after `pnpm build`.
- `ROOT_DIR` defaults to a hardcoded local path in `index.ts` — it must be set explicitly for anything other than the author's machine.
- The router only matches under `/api/`; anything else gets a 404 before route matching (see `app.ts`).
- Biome ignores `dist/`, `node_modules/`, and `pnpm-lock.yaml` via `biome.json`/`.gitignore` — don't expect lint coverage on build output.
