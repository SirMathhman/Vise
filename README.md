# Vise

A pnpm-workspaces monorepo with a vanilla TypeScript backend (raw Node `http`) and a vanilla TypeScript frontend (Vite).

## Layout

```
apps/
  backend/   Node http server, compiled with tsc (ESM)
  frontend/  Vite + vanilla TS SPA
```

The backend is layered: `router.ts` (pure matching), `http.ts` (response), `errors.ts` (structured errors), `context.ts` (deps), `routes/*.ts` (handlers), composed by `app.ts`.

## Setup

```
pnpm install
```

## Develop (backend :3001 + frontend :5173)

```
pnpm dev
```

The Vite dev server proxies `/api` to the backend, so the frontend can call `/api/...` directly.

## Build / Typecheck / Lint

```
pnpm build
pnpm typecheck
pnpm lint
pnpm format
```

Linting and formatting are handled by [Biome](https://biomejs.dev) at the repo root (`biome.json`).
