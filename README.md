# Vise

A pnpm-workspaces monorepo with a vanilla TypeScript backend (raw Node `http`) and a vanilla TypeScript frontend (Vite).

## Layout

```
apps/
  backend/   Node http server, compiled with tsc (CommonJS)
  frontend/  Vite + vanilla TS SPA
```

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

Linting and formatting are handled by [Biome](https://biomejs.dev) at the repo root (`biome.json`). A single intentional warning is expected: the `ctx` parameter of `createApp` is currently unused (forward-looking dependency container).
