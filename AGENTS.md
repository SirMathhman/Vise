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
- **Composition root:** `src/main.js` is a thin wiring module — it imports the render layer and behavior modules, then calls them. Keep it small; do not add rendering or feature logic here.
- **Rendering:** `src/render.js` exports `renderApp(appEl)` (page shell), `renderTree(el, entries, path)`, and `renderChildren(li, entries, path)`, building DOM via `createElement`/`replaceChildren`. Add new markup here, not in `main.js`.
- **Network layer:** `src/api.js` owns **all** `fetch('/api/*')` calls (`fetchEntries`, `fetchFileContent`, `sendChat`). Keep network I/O here, not in behavior modules.
- **Behavior modules:** each feature is a `setup*(appEl)` module that attaches event listeners (via delegation on `appEl`) and delegates rendering to `render.js`:
  - `src/listing.js` — `setupTree`: expand/collapse the directory tree, lazy-loading children.
  - `src/fileViewer.js` — `setupFileViewer`: click a file → fetch content → render with line numbers.
  - `src/chat.js` — `setupChat`: submit the form → send the conversation → append the reply.
- **Dependency direction:** one-way only — `main.js → {render, listing, fileViewer, chat}`; `listing/fileViewer/chat → {render, api}`. `api.js` and `render.js` are leaves and must not import behavior modules or `main.js`.
- **API access:** the frontend calls **relative** `/api/*` paths. In dev, Vite proxies `/api` to the backend (see `vite.config.js`); in production the backend serves both. Do not hardcode backend host/port in frontend code.
- **Styling:** `src/style.css` uses **native CSS nesting**, CSS custom properties (design tokens in `:root`), and `prefers-color-scheme` for dark mode. Follow the existing token-based approach (`var(--accent)`, etc.) rather than hardcoding colors.
- **Static assets:**
  - `public/` — served as-is at the site root (e.g. `/favicon.svg`). Reference with an absolute `/` path.
  - `src/assets/` — imported in JS so Vite processes/hashes them.

### Backend (`apps/server`)

- **Entry point:** `index.js` creates the `http` server and routes requests. Keep it thin.
- **Routing:** requests starting with `/api/` go to `api.js`; everything else is served as static files from the frontend build (`apps/web/dist`) via `static.js`.
- **API handlers:** `api.js` maps routes to handlers:
  - `GET /api/listing[?path=rel]` — directory entries (logic in `listing.js`).
  - `GET /api/file?path=rel` — file text content (logic in `listing.js`).
  - `POST /api/chat { messages }` — LLM reply (logic in `chat.js`).
- **Path safety:** `pathGuard.js` exports `resolveWithin(root, rel)` — the single path-traversal guard used by both `api.js` and `static.js`. Use it for any new path-based route.
- **LLM proxy + tools:** `chat.js` calls an OpenAI-compatible endpoint (env vars `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, with hardcoded defaults) and runs a **function-calling loop**: the model may call the `list_directory` tool to inspect the repository. Tools live in `tools.js` — each tool's _definition_ (schema) and _executor_ are co-located in one registry entry, so adding a tool is a single-file change. `api.js` passes the `TOOLS` registry to `chat.js`; `chat.js` stays tool-agnostic.
- **Static serving:** `static.js` serves files with correct MIME types and guards against path traversal.
- **Dependency direction:** one-way only — `index.js → {api, static}`; `api.js → {listing, pathGuard, chat, tools}`; `tools.js → {listing, pathGuard}`; `static.js → pathGuard`. Leaf modules (`listing.js`, `pathGuard.js`, `chat.js`, `tools.js`) must not import `index.js` or `api.js`.
- **No dependencies:** use Node built-ins (`node:http`, `node:fs/promises`, `node:path`, `node:url`). Do not add Express or other frameworks without explicit request.

## Pitfalls

- Do not add a framework or build tool without explicit request — this is intentionally plain Vite + vanilla JS + Node `http`.
- The backend lists the **repository root** (`repoRoot` in `listing.js`, three levels up from `apps/server/`), not the CWD. All `/api/listing` and `/api/file` paths are resolved relative to that root and must stay within it.
- `public/` assets are not processed by Vite; use `src/assets/` imports when you need bundling/hashing.
- CSS uses native nesting — keep it consistent; do not introduce a CSS preprocessor.
- Production serving requires the frontend to be built first (`npm run build`) so `apps/web/dist` exists.
- The LLM API key has a hardcoded default in `apps/server/chat.js`; override with `LLM_API_KEY` in production.
