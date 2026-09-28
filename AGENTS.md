# Vise — Agent Instructions

Vise is an interactive LLM chat REPL written in TypeScript on the Bun runtime.
Full design rationale, invariants, and target layout live in [ARCHITECTURE.md](ARCHITECTURE.md) — read it before making structural changes.

## Commands

| Task       | Command             | Notes                                                               |
| ---------- | ------------------- | ------------------------------------------------------------------- |
| Run        | `bun run index.ts`  | Entry point. No build step — Bun transpiles TS on the fly.          |
| Install    | `bun install`       | Only dev deps are `@types/bun` and `typescript`; zero runtime deps. |
| Type-check | `bunx tsc --noEmit` | No `typecheck`/`test`/`lint` scripts exist in `package.json`.       |
| Test       | _(none)_            | No test framework or test directory yet.                            |

## Hard rules (from the architecture invariants)

- **No `process.exit()` anywhere.** Termination happens when the event loop drains; set `process.exitCode` instead. `process.exit()` truncates buffered stdout through pipes.
- **The core (`src/core/`) is pure.** No `node:` imports, no `console`, no `process`, no globals. Same input → same output.
- **No `throw` in core paths.** Errors are the structured `Result<T>` / `ViseError` union from `src/core/errors.ts`. All display formatting belongs in `src/output/format.ts`.
- **Dependency arrows point edge → core only.** `client/llm.ts` is the sole module that performs network I/O; `src/tools.ts` is the edge implementation of the core's `Tool`/`ToolRunner` types.
- **Explicit `.ts` extensions on all imports** (`allowImportingTsExtensions`), ESM throughout.
- **Size limits:** files < 500 code lines, functions < 100 lines. Split at a natural seam when approaching the limit.

## Current-state notes (code lags the architecture doc)

- `index.ts` is still fused entry+driver+readline wiring. There is no `src/cli.ts` or `src/driver/` yet — the TTY/pipe split is the main outstanding refactor. Don't add TTY/pipe special-casing into `index.ts`.
- `src/core/engine.ts` mutates the `messages` array in place by design; it's a documented side channel, not a bug.
- `RECENT_TURNS_TO_KEEP` in `src/repl/session.ts` and `MAX_TOOL_ROUNDS` in `src/core/engine.ts` are the compaction/tool-loop bounds.
- `API_KEY`, `URL`, `MODEL` are hardcoded constants in `src/client/llm.ts` (no env config by design — local-only tool).
- **Profiles:** `/profile <name>` loads a `.md` file from the `profiles/` directory and appends its text as a user message to the conversation. The system message is never modified (invariant #6). The `ProfileSource` interface is owned by the core (`src/repl/session.ts`); the edge (`index.ts` `FileProfileSource`) does the `node:fs` I/O. Same edge-owns-I/O pattern as `ModelController`.
- **Pre-turn hooks:** One or more shell commands (configured in `.viserc.json` as `preTurnCommand`) run in parallel before every turn; each hook's output is injected as a user message before the user's input, in config order. **Post-turn hooks:** One or more shell commands (configured in `.viserc.json` as `postTurnCommand`) run in parallel after every successful turn; each hook's output is injected as a user message after the assistant's reply, in config order. Each hook key accepts either a single command string or an array of command strings. The `PreTurnHook`/`PostTurnHook` interfaces are core-owned (`src/repl/session.ts`); the edge (`index.ts` `ShellHook`) spawns `powershell.exe`. Same edge-owns-I/O pattern.

## Environment

- The LLM is a **local llama.cpp server** at `http://localhost:8080` (OpenAI-compatible API).
- **Do not start a second `llama-server` instance if one is already running** — it causes memory issues. Check port 8080 first.
- `run_powershell` in `src/tools.ts` hardcodes `powershell.exe` with a 60-second SIGTERM timeout. This is a Windows-only tool; there is no shell tool for other platforms.

## Pitfalls

- A single large `read_file` tool result can blow the context window — tool output is unbounded (no truncation/pagination yet).
- `toolRunner.run` returns ` error: unknown tool ${name}` as a plain string, not a `ViseError` variant. Keep it that way until structured tool errors land (see "Future Work" in ARCHITECTURE.md).
- `contextMax()` must be queried live per model, never cached — window sizes differ per model.
