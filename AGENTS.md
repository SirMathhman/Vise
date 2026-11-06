# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- Install: `bun install`
- Run the chat app: `bun run start` (same as `bun run index.ts`). It needs `OPENROUTER_API_KEY` in `.env`; Bun loads that file itself.
- Test all: `bun test`
- Test one file: `bun test src/repl/repl.test.ts`. One test by name: `bun test src/repl/repl.test.ts -t "name substring"`.
- Lint: `bun run lint` runs ESLint and `scripts/check-files-per-dir.ts`. Both must pass.
- Type check: `bunx tsc --noEmit`

The tests run on Windows and spawn real `powershell.exe`, `taskkill`, and temp directories, so they need a Windows machine. No test calls OpenRouter. A live check means piping input into `bun run index.ts`, for example `printf 'hi\n/exit\n' | bun run index.ts`, which uses the real key and costs a request.

## Lint rules that will fail the build

ESLint is configured in `eslint.config.js`. These are errors, not warnings:

- No `throw` statements. Failures are returned as `Result` (`src/core/result.ts`, `ok` and `err`). The only `try`/`catch` is around calls that throw by themselves.
- No inline object types written as `{ ... }`. Declare an `interface`.
- No function-typed fields in an interface. Declare a method instead, such as `reply(request: ReplyRequest): ...`, not `reply: (request: ReplyRequest) => ...`.
- At most 500 code lines per file and 100 per function (blank lines and comments do not count).
- At most 10 tracked files per directory, checked by `scripts/check-files-per-dir.ts` with `git ls-files`. New files count only once staged.

## Architecture

`ARCHITECTURE.md` is the canonical design document. It holds the invariants, which the code must keep, and some sections describe the target shape rather than the code. Read it before changing behaviour, and keep it current.

The app is a terminal REPL. Its layers, from the outside in:

- `index.ts` is the composition root. It reads `OPENROUTER_API_KEY`, passes `streamChat`, `modelContextWindow`, and `runTool` into `runRepl`, and stops background jobs on every exit path.
- `src/repl/repl.ts` owns readline, the session loop, and the turn loop. Input goes through `InputLines`, a queue that approvals and chat lines share.
- `src/core/` is pure: line classification (`commands.ts`), the conversation state and compaction (`compaction.ts`), tool specs and argument parsing (`tools.ts`), and the shared types and ports (`messages.ts`).
- `src/openrouter.ts` is the only network code. It converts history to the wire format, streams events, and returns each text delta as a `Result`.
- `src/tools/` runs tool calls. `run-tool.ts` dispatches by name. `files/` holds disk tools that share `contain.ts`. `run-powershell.ts` and `jobs.ts` run commands and track background jobs.

Behaviour you cannot see from a single file:

- The REPL runs a turn as a loop of model requests. A round asks the model, and each tool call it returns runs and goes into the history before the next round. `streamChat` buffers tool-call fragments and emits each complete call only when the stream ends.
- The model's tools are the same in every request. The request body marks the last plain-text message with `cache_control`. The history is append-only, except for compaction. A failed round removes its whole turn. Keep these together, because they are what makes the provider's prompt cache work.
- Writes and commands are approved by the user on the terminal. The `approve` callback that the REPL passes to `runTool` reads the next line after the preview. Lines typed before the preview are discarded. The check is done in `runTool`, not in the loop, so a second caller cannot skip it.
- Once input has ended or a stream has failed, no further request is sent and no tool call runs. Queued lines still count as input, and a message that was already queued is still answered.
- Compaction (`/compact`, or automatically at 80% of the window) asks the model for a summary of the whole history and keeps the summary plus the last six messages.
- A command still running after 30 seconds becomes a background job. The model reads or kills it with `read_command` and `kill_command`. Killing needs approval. At most five jobs run, and index.ts stops them on exit.

Tests live beside the module they test. There is no separate `tests/` folder.
