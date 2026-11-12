# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `bun install`
- Run the terminal chat app: `bun run start` (same as `bun run index.ts`). Run the browser frontend with `bun run web` or `bun run index.ts --web`. Both need at least one provider listed in `.vise/providers.json` (setup is in README.md). Keys are read from that file only, never from the environment.
- Browser server with restart on change: `bun run web:dev`.
- Test all: `bun test`
- Test one file: `bun test src/repl/repl.test.ts`. One test by name: `bun test src/repl/repl.test.ts -t "name substring"`.
- Lint: `bun run lint` runs ESLint and `scripts/check-files-per-dir.ts`. Both must pass.
- Type check: `bunx tsc --noEmit` and `bunx tsc --noEmit -p src/web/client` (the browser page has its own tsconfig)

The tests run on Windows and spawn real `powershell.exe`, `taskkill`, and temp directories, so they need a Windows machine. No test calls OpenRouter. A live check means piping input into `bun run index.ts`, for example `printf 'hi\n/exit\n' | bun run index.ts`, which uses the real key and costs a request.

## Lint rules that will fail the build

ESLint is configured in `eslint.config.js`. These are errors, not warnings:

- No `throw` statements. Failures are returned as `Result` (`src/core/messages.ts`, `ok` and `err`). The only `try`/`catch` is around calls that throw by themselves.
- No inline object types written as `{ ... }`. Declare an `interface`.
- No function-typed fields in an interface. Declare a method instead, such as `reply(request: ReplyRequest): ...`, not `reply: (request: ReplyRequest) => ...`. A field typed by a function alias is not caught by the rule, so keep to the convention there too.
- At most 4 parameters per function. A function that needs more takes one parameter object, declared as an interface.
- At most 500 code lines per file and 100 per function (blank lines and comments do not count).
- At most 10 tracked files per directory, checked by `scripts/check-files-per-dir.ts` with `git ls-files`. New files count only once staged, so stage a new file before running lint.

## Architecture

`ARCHITECTURE.md` is the canonical design document: its invariants (F1 to F5, N1 to N6), its behaviour, its security model, and its target file layout. Read the relevant part before changing behaviour, and keep it current. Some sections describe the target shape rather than the code, so check the file before assuming a module does what the document says.

The code is split into a frontend and a backend, joined by a typed event protocol. Only `index.ts` connects them:

- `index.ts` is the composition root. It reads `OPENROUTER_API_KEY` and the tool and model settings, passes the backend's ports (such as `streamChat`, `modelContextWindow`, and `runTool`) into `startSession`, and then runs either the terminal REPL or, with `--web`, the browser server. It is the only place that touches `process`.
- `src/backend/` is the session engine, with no terminal and no readline. `session.ts` runs the session loop and the line inbox, `turn.ts` runs a message's tool rounds, `calls.ts` runs one round's calls, and `commands/` handles the slash commands. `subagent/` runs `run_subagent`.
- `src/protocol/` holds the frontend-backend types (plain data, no functions) and the async channel the inbox is built on.
- `src/repl/` is the terminal frontend: `repl.ts` owns readline and prints events, and `render.ts` turns events into terminal text and sanitizes them.
- `src/web/` is the browser frontend: a WebSocket relay in `server/` and a plain TypeScript page in `client/`. The client is built for the browser and never runs under Bun.
- `src/core/` is pure: line classification (`commands.ts`), the conversation state and compaction (`compaction.ts`), tool specs and argument parsing (`tools.ts`), notes and profiles (`notes.ts`), saved sessions (`sessions.ts`), and the shared types and ports (`messages.ts`).
- `src/providers/` is the model provider behind the `Provider` contract in `src/core/messages.ts`. `provider.ts` builds one provider from `.vise/providers.json`, `openrouter.ts` and `llama-cpp.ts` are the network adapters (they share the stream in `openrouter.ts`), and `router.ts` sends a `<name>::<id>` model to its provider. Only `openrouter.ts`, `llama-cpp.ts`, and `src/tools/mcp/http-client.ts` open network connections.
- `src/tools/` does the disk, process, and settings work. `run-tool.ts` dispatches calls by name and checks the target before asking for approval. `mcp/` starts the MCP servers listed in `.vise/mcp.json` and runs their tools as `<server>__<tool>`. `files/` holds the file tools and shares `contain.ts`. `run-powershell.ts` and `jobs.ts` run commands and track background jobs. `undo/` holds the undo log (`undo-log.ts`, pure) and the file reverts (`undo-files.ts`). `hooks/`, `notes/`, `models/`, `resume/`, and the settings and session stores are beside them.

Tests live beside the module they test. There is no separate `tests/` folder.

## Documentation

- `README.md` is the quick start for people: setup, providers, running the app, and the files under `.vise/`. It does not repeat the commands below.
- `AGENTS.md` (this file) is the reference for making a change: commands, lint rules, and the code layout.
- `ARCHITECTURE.md` is the design: invariants, behaviour, the security model, the target layout, Known Problems, and Future Work. When a change fixes a Known Problem, remove it; when it adds a gap, record it there with its location.
- Do not add documentation files at the repository root. The root is close to the file limit (see Lint rules), so put new docs in a folder.
