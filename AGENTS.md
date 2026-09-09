# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project Overview

A **frontend + backend** monorepo (npm workspaces) using **vanilla JavaScript** (no framework) and **Node's built-in `http`** module (no Express).

- **`apps/web`** — Vite frontend. Renders a single-page UI that fetches data from the backend and displays it.
- **`apps/server`** — Node backend. Serves a JSON API and, in production, serves the built frontend.

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
- **Rendering:** `src/render.js` exports `renderApp(appEl)` (page shell) and `renderListing(el, names)` (data view), building DOM via template literals assigned to `innerHTML`. Add new markup here, not in `main.js`.
- **Data fetching:** `src/listing.js` owns the `fetch('/api/listing')` call and delegates rendering to `render.js`. Keep network I/O in leaf modules, not in `main.js`.
- **Dependency direction:** one-way only — `main.js → render.js` and `main.js → listing.js`; `listing.js → render.js`. Leaf modules must not import `main.js`.
- **API access:** the frontend calls **relative** `/api/*` paths. In dev, Vite proxies `/api` to the backend (see `vite.config.js`); in production the backend serves both. Do not hardcode backend host/port in frontend code.
- **Styling:** `src/style.css` uses **native CSS nesting**, CSS custom properties (design tokens in `:root`), and `prefers-color-scheme` for dark mode. Follow the existing token-based approach (`var(--accent)`, etc.) rather than hardcoding colors.
- **Static assets:**
  - `public/` — served as-is at the site root (e.g. `/favicon.svg`). Reference with an absolute `/` path.
  - `src/assets/` — imported in JS so Vite processes/hashes them.

### Backend (`apps/server`)

- **Entry point:** `index.js` creates the `http` server and routes requests. Keep it thin.
- **Routing:** requests starting with `/api/` go to `api.js`; everything else is served as static files from the frontend build (`apps/web/dist`) via `static.js`.
- **API handlers:** `api.js` maps routes to handlers. Currently `GET /api/listing` returns a JSON array of top-level entry names in the CWD (logic in `listing.js`).
- **Static serving:** `static.js` serves files with correct MIME types and guards against path traversal.
- **Dependency direction:** one-way only — `index.js → api.js`, `index.js → static.js`, `api.js → listing.js`. Leaf modules must not import `index.js`.
- **No dependencies:** use Node built-ins (`node:http`, `node:fs/promises`, `node:path`, `node:url`). Do not add Express or other frameworks without explicit request.

## Pitfalls

- Do not add a framework or build tool without explicit request — this is intentionally plain Vite + vanilla JS + Node `http`.
- The backend lists the **current working directory**; run it from the directory you want listed.
- `public/` assets are not processed by Vite; use `src/assets/` imports when you need bundling/hashing.
- CSS uses native nesting — keep it consistent; do not introduce a CSS preprocessor.
- Production serving requires the frontend to be built first (`npm run build`) so `apps/web/dist` exists.
