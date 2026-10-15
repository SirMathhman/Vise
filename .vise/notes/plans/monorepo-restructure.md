## Plan: Monorepo Restructure

Split the current single-package Bun/TypeScript project into an `apps/` + `packages/` monorepo using Bun's built-in workspace support. Four packages (`core`, `backend`, `frontend`, `common`) and three apps (`cli`, `web`, `extension`). No publishing — purely for boundary clarity. Tooling (tsconfig base, eslint, build scripts) stays at the root.

**Target layout**

```
Vise/
├── apps/
│   ├── cli/                  — terminal REPL
│   │   ├── index.ts          — entry point (from index.ts)
│   │   ├── src/
│   │   │   ├── terminal-main.ts
│   │   │   └── driver/         (from src/driver/)
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── web/                  — web server + serves the frontend
│   │   ├── src/
│   │   │   ├── main.ts         (from src/web/main.ts)
│   │   │   ├── server.ts       (from src/web/server.ts)
│   │   │   ├── api/            (from src/web/api/)
│   │   │   ├── conn/           (from src/web/conn/)
│   │   │   ├── ext/            (from src/web/ext/)
│   │   │   ├── inspect/
│   │   │   ├── port.ts
│   │   │   └── assets.ts
│   │   ├── dist/             — web bundle output (was web/dist/)
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── extension/            — Firefox extension
│       ├── src/              (from extension/src/)
│       ├── dist/
│       ├── manifest.json
│       ├── options.html
│       ├── sidebar.html
│       ├── tsconfig.json
│       └── package.json
├── packages/
│   ├── core/                 — pure logic (from src/core/)
│   │   ├── src/
│   │   │   ├── index.ts      — barrel re-export
│   │   │   ├── engine.ts
│   │   │   ├── errors.ts
│   │   │   ├── goal.ts
│   │   │   ├── goal-trace.ts
│   │   │   ├── progress.ts
│   │   │   ├── todos.ts
│   │   │   ├── workflow.ts
│   │   │   ├── workflow-profiles.ts
│   │   │   ├── audit.ts
│   │   │   ├── call/          (reasoning.ts, runaway.ts)
│   │   │   └── hooks/         (tool-hook-match.ts)
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── backend/              — server-side shared code
│   │   ├── src/
│   │   │   ├── index.ts      — barrel re-export
│   │   │   ├── client/        (from src/client/)
│   │   │   ├── tools/         (from src/tools/ + src/tools.ts)
│   │   │   ├── repl/          (from src/repl/)
│   │   │   ├── stores/        (from src/stores/)
│   │   │   ├── db/            (from src/db/)
│   │   │   ├── browser/       (from src/browser/)
│   │   │   ├── output/        (from src/output/)
│   │   │   ├── mcp/           (from src/mcp/)
│   │   │   ├── config.ts
│   │   │   ├── wiring.ts
│   │   │   ├── data-dir.ts
│   │   │   ├── edge-sources.ts
│   │   │   ├── fs-tree.ts
│   │   │   ├── global-prompt.ts
│   │   │   └── version.ts
│   │   ├── tsconfig.json
│   │   └── package.json
│   ├── frontend/             — browser UI (from web/src/)
│   │   ├── src/              (from web/src/)
│   │   ├── index.html        (from web/index.html)
│   │   ├── styles/           (from web/styles/)
│   │   ├── tsconfig.json
│   │   └── package.json
│   └── common/               — shared protocol types (NEW)
│       ├── src/
│       │   ├── messages.ts   — WireMessage, ServerMessage types
│       │   └── index.ts
│       ├── tsconfig.json
│       └── package.json
├── scripts/                  — build scripts (stays here)
├── assets/
├── docs/
├── package.json              — root, with "workspaces"
├── tsconfig.base.json
├── tsconfig.json             — solution-style (references)
├── eslint.config.js
├── AGENTS.md
├── ARCHITECTURE.md
└── bun.lock
```

**Dependency graph**

```
packages/core          ← (no deps, pure)
packages/common        ← (no deps, pure types)
packages/backend       ← depends on: @vise/core, @vise/common
packages/frontend      ← depends on: @vise/common (build-time only)
apps/cli               ← depends on: @vise/backend, @vise/core
apps/web               ← depends on: @vise/backend, @vise/core, @vise/frontend, @vise/common
apps/extension         ← depends on: @vise/backend (for config.ts), @vise/common
```

No circular dependencies.

**Steps**

### Phase 1 — Scaffold (no code moves yet)

1. **Add `workspaces` to root `package.json`:**
   `"workspaces": ["apps/*", "packages/*"]`
   Keep `"private": true`. Remove `"module": "index.ts"` (entry points move to apps).

2. **Create `tsconfig.base.json`** at root with the shared compiler options currently in the root `tsconfig.json` (strict, allowImportingTsExtensions, module: esnext, target, etc.). The root `tsconfig.json` becomes a solution file ("files": [], references to each package) or is kept as the base that each package extends.

3. **Create a `package.json` stub for each new package and app** with `"name"` (`"@vise/core"`, `"@vise/backend"`, etc.), `"private": true`, `"type": "module"`, and the appropriate `"dependencies"` pointing to sibling packages. No `main`/`exports` field needed since everything is TS run by Bun.

**Verifiable:** `bun install` succeeds; `bunx tsc --noEmit` still passes.

### Phase 2 — Extract `packages/core`

4. **Move `src/core/` → `packages/core/src/`.**
   - No import changes needed (confirmed self-contained by explore).
   - Create `packages/core/src/index.ts` barrel re-exporting everything.
   - Create `packages/core/package.json` with `"name": "@vise/core"`.
   - Create `packages/core/tsconfig.json` extending `tsconfig.base.json`.

5. **Update all imports in `src/` that reference `src/core/`.**
   - Files in `src/` import core types via relative paths (`./core/engine.ts`, `../core/errors.ts`).
   - Replace with `import { ... } from "@vise/core"`.
   - This is the largest mechanical change: every file in `src/` that imports from `core/` needs its import path updated.

**Verifiable:** `bunx tsc --noEmit` passes. `bun test` passes. `bun run lint` passes.

### Phase 3 — Extract `packages/common`

6. **Create `packages/common/src/messages.ts`** with the protocol types currently defined in `src/web/router/connection.ts` (`WireMessage`, and any server→client message type definitions). Move the _type definitions_ only; the router logic stays in the web app.

7. **Update imports:**
   - `src/web/router/connection.ts` imports types from `@vise/common`.
   - `web/src/` (future `packages/frontend/`) will also import from `@vise/common` — a build-time dependency.

**Verifiable:** `bunx tsc --noEmit` passes. No behavioral change.

### Phase 4 — Create `packages/frontend`

8. **Move `web/src/` → `packages/frontend/src/`, `web/index.html` → `packages/frontend/index.html`, `web/styles/` → `packages/frontend/styles/`.**
   - The frontend has zero imports from `src/` (confirmed by explore), so this is a pure move.
   - Its only external dependencies are npm packages (`marked`, `dompurify`, `@xterm/xterm`, `@xterm/addon-fit`) and `@vise/common`.
   - Create `packages/frontend/package.json` with those deps.
   - The `build:web` script updates its entry to `packages/frontend/src/app.ts`.

**Verifiable:** `bun run build:web` produces the same bundle. `bun run typecheck:web` passes.

### Phase 5 — Create `apps/cli`

9. **Move the terminal entry into `apps/cli/`:**
   - `index.ts` → `apps/cli/index.ts`
   - `src/terminal-main.ts` → `apps/cli/src/terminal-main.ts`
   - `src/driver/` → `apps/cli/src/driver/`
   - `apps/cli/package.json` with deps on `@vise/backend`, `@vise/core`.
   - `apps/cli/tsconfig.json`.

10. **Update `build:exe` script** to compile from `apps/cli/index.ts` instead of `index.ts`.

**Verifiable:** `bun run apps/cli/index.ts` starts the terminal REPL. `bun run build:exe` produces `out/vise-cli.exe`.

### Phase 6 — Create `apps/web`

11. **Move `src/web/` → `apps/web/src/`:**
    - `src/web/main.ts` → `apps/web/src/main.ts`
    - `src/web/server.ts` → `apps/web/src/server.ts`
    - `src/web/api/`, `src/web/conn/`, `src/web/ext/`, `src/web/inspect/`, `src/web/port.ts`, `src/web/assets.ts` → `apps/web/src/`
    - `apps/web/package.json` with deps on `@vise/backend`, `@vise/core`, `@vise/frontend`, `@vise/common`.
    - `apps/web/tsconfig.json`.

12. **Update `build:web` script:** entry is `packages/frontend/src/app.ts`, output goes to `apps/web/dist/`. The server's asset import (`apps/web/src/assets.ts` using `import ... with { type: "file" }`) updates its path.

13. **Update `web` and `dev:web` scripts:**
    - `"web"`: `bun run build:web && bun apps/web/src/main.ts`
    - `"dev:web"`: `bun scripts/dev-web.ts` (the dev script updates its spawn path)

**Verifiable:** `bun run web` starts the server, page loads, chat works. `bun run build:exe` produces `out/vise.exe`.

### Phase 7 — Create `apps/extension`

14. **Move `extension/` → `apps/extension/`:**
    - `extension/src/` → `apps/extension/src/`
    - `extension/manifest.json`, `extension/options.html`, `extension/sidebar.html`, `extension/tsconfig.json` → `apps/extension/`
    - `apps/extension/package.json` with `"name": "@vise/extension"`.
    - The extension is self-contained (no imports from `src/`), so this is a pure move.
    - It depends on `@vise/backend` for `config.ts` (bundled per AGENTS.md) and `@vise/common`.

15. **Update `build:ext` script** to point to `apps/extension/`.

**Verifiable:** `bun run build:ext` produces `apps/extension/dist/`. `bun run typecheck:ext` passes.

### Phase 8 — Consolidate `packages/backend`

16. **After steps 2–7, the remaining `src/` files form `packages/backend/`:**
    - `src/client/` → `packages/backend/src/client/`
    - `src/tools/` + `src/tools.ts` → `packages/backend/src/tools/`
    - `src/repl/` → `packages/backend/src/repl/`
    - `src/stores/` → `packages/backend/src/stores/`
    - `src/db/` → `packages/backend/src/db/`
    - `src/browser/` → `packages/backend/src/browser/`
    - `src/output/` → `packages/backend/src/output/`
    - `src/mcp/` → `packages/backend/src/mcp/`
    - `src/config.ts`, `src/wiring.ts`, `src/data-dir.ts`, `src/edge-sources.ts`, `src/fs-tree.ts`, `src/global-prompt.ts`, `src/version.ts` → `packages/backend/src/`
    - Create `packages/backend/package.json` with deps on `@vise/core`.
    - Create `packages/backend/tsconfig.json`.

17. **Update all cross-references:**
    - `apps/cli/src/` imports from `@vise/backend`.
    - `apps/web/src/` imports from `@vise/backend`.
    - Internal imports within the backend (e.g. `client/` importing from `repl/`) stay relative.
    - `packages/backend/src/wiring.ts` is the main entry that `apps/cli` and `apps/web` import.

**Verifiable:** `bunx tsc --noEmit` passes. `bun test` passes. `bun run web` works. `bun run apps/cli/index.ts` works. `bun run build:exe` works.

### Phase 9 — Cleanup and polish

18. **Remove the old `src/` directory** (everything now lives in `packages/` or `apps/`).

19. **Update `test/` directory** — tests currently import from `src/` via relative paths. Co-locate tests with each package (`packages/core/test/`, `packages/backend/test/`, etc.). The root `bun test` script discovers them via workspaces. Alternatively, keep a root `test/` and update imports to workspace names.

20. **Update `eslint.config.js`** — the `lint` script currently targets `src/ test/ index.ts web/ extension/`. Update to target `packages/ apps/`.

21. **Update `AGENTS.md`** — all file path references (`src/core/engine.ts`, `src/wiring.ts`, `web/src/...`, `extension/src/...`) need updating to the new paths.

22. **Update `.gitignore`** — `web/dist/` → `apps/web/dist/`. `extension/dist/` → `apps/extension/dist/`.

23. **Update `scripts/build-exe.ts`, `scripts/build-ext.ts`, `scripts/dev-web.ts`, `scripts/rebuild.ps1`** — all path references to source files.

24. **Update `bunfig.toml`** if it references any paths.

**Relevant files**

- `package.json` — add `"workspaces"`, remove `"module"`, update all script paths
- `tsconfig.json` — becomes solution-style or base reference
- `tsconfig.base.json` — **new**: shared compiler options
- `eslint.config.js` — update file patterns
- `scripts/build-exe.ts` — update entry points to `apps/cli/index.ts` and `apps/web/src/main.ts`
- `scripts/build-ext.ts` — update path to `apps/extension/`
- `scripts/dev-web.ts` — update spawn paths
- `apps/web/src/assets.ts` — update embedded file paths for the web bundle
- `AGENTS.md` — update all file path references
- `.gitignore` — update dist paths
- `.env.example` — no path changes needed (env var names unchanged)

**Verification**

1. `bun install` — workspace resolution succeeds, no errors.
2. `bunx tsc --noEmit` — all packages type-check clean.
3. `bun run typecheck:web` — frontend type-checks.
4. `bun run typecheck:ext` — extension type-checks.
5. `bun test` — all tests pass.
6. `bun run lint` — no new warnings or errors.
7. `bun run web` — web UI loads, chat works, tools work, browser works, extension sidebar works.
8. `bun run apps/cli/index.ts` — terminal REPL starts, chat works, `/model`, `/tool`, `/profile` all work.
9. `bun run build:exe` — produces `out/vise.exe` and `out/vise-cli.exe`, both functional (web UI embedded, terminal driver works).
10. `bun run build:ext` — produces `apps/extension/dist/` loadable in Firefox via `about:debugging`.
11. `bun run build:web` — produces the frontend bundle in `apps/web/dist/`.
12. `bun run dev:web` — watch mode rebuilds the frontend and restarts the server.
13. `scripts/rebuild.ps1` — full rebuild while running works (rename + swap pattern unchanged).

**Decisions**

- **Granularity:** coarse — `packages/core` (pure logic), `packages/backend` (all server-side shared), `packages/frontend` (browser UI), `packages/common` (protocol types). Three apps: `cli`, `web`, `extension`. This matches the user's stated intent of "frontend, backend, common, and anything else."
- **No publishing:** all packages are `"private": true`. No `main`/`exports`/`types` fields needed since everything is TS run by Bun directly.
- **Bun workspaces only:** no turbo, no nx, no pnpm. Bun's native `"workspaces"` field handles resolution. `bun install`, `bun test`, `bunx tsc` all work unchanged.
- **Core stays pure:** `packages/core` has zero `node:`, `console`, `process` imports (already true). It is the leaf of the dependency graph.
- **Backend is one package:** all server-side shared code (client, tools, repl, stores, db, browser, output, mcp, config, wiring) lives in `packages/backend`. The user chose to split only core out.
- **Frontend is self-contained:** it talks to the server only via WebSocket messages typed by `@vise/common`. No runtime TS import from backend.
- **Extension depends on backend for `config.ts`:** per AGENTS.md, `config.ts` is bundled into the extension. This is a compile-time dependency, not a runtime one (the extension runs in Firefox, not on the server).
- **Tooling at root:** `tsconfig.base.json`, `eslint.config.js`, `scripts/` all stay at the repo root. No `@vise/tooling` package.
- **Barrel exports:** each package gets a `src/index.ts` re-exporting its public API. Consumers import from the package name, not deep paths.
- **Tests co-located:** each package gets its own `test/` directory. The root `bun test` discovers them via workspaces.
- **Compiled output unchanged:** `out/vise.exe` and `out/vise-cli.exe` keep their names and locations. `apps/extension/dist/` keeps its structure.
- **`.vise/` runtime data directory:** unaffected. The SQLite database, profiles, notes, workflows all stay where they are.

**Scope exclusions**

- No changes to runtime behavior — this is a pure restructure.
- No changes to the compiled output format or names.
- No changes to the `.vise/` runtime data directory or SQLite schema.
- No changes to the `.env` settings or `SPEC` config keys.
- No changes to the WebSocket protocol message shapes.
- No publishing to npm or any registry.
- No new build tooling beyond what Bun already provides.

**Further considerations**

1. **Import style for `@vise/core`:** use the package name (`import { ... } from "@vise/core"`) or relative paths within the backend? Recommendation: package name for cross-package imports, relative within a package. Bun resolves workspace packages by name automatically.
2. **`bunfig.toml`:** check whether it references any paths that need updating. If it's only test/preview config, it may be fine as-is.
3. **CI (if added later):** a GitHub Actions workflow would run `bun install`, `bunx tsc --noEmit`, `bun test`, `bun run lint`, `bun run build:web`, `bun run build:ext`. No monorepo-specific CI tooling needed since there's no publish step.
