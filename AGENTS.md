# Vise — Agent Instructions

Vise is an interactive LLM chat REPL written in TypeScript on the Bun runtime.
Full design rationale, invariants, and target layout live in [ARCHITECTURE.md](ARCHITECTURE.md) — read it before making structural changes.

## Commands

| Task       | Command             | Notes                                                               |
| ---------- | ------------------- | ------------------------------------------------------------------- |
| Run        | `bun run index.ts`  | Entry point. No build step — Bun transpiles TS on the fly.          |
| Install    | `bun install`       | Only dev deps are `@types/bun` and `typescript`; zero runtime deps. |
| Type-check | `bunx tsc --noEmit` | No `typecheck`/`lint` scripts exist in `package.json`.              |
| Test       | `bun test`          | Bun's built-in `bun:test` runner; suites live in `test/`.           |

## Surface (product features an agent touches)

Two surfaces an agent commonly edits. The list below is a quick reference — the
authoritative definitions live in the source files linked.

**User-facing slash commands** — dispatched in `Session.handleLine`
(`src/repl/session.ts`); help text is rendered by `formatHelp` in
`src/output/format.ts`. To add one, handle it in `handleLine` and add it to
`formatHelp`.

- `/exit`, `/help`, `/context`, `/compact`
- `/model` (list) / `/model <name>` (switch) — via `ModelController`
- `/tool` (list) / `/tool <name> enable|disable` — via `ToolController`
- `/profile` (list) / `/profile <name>` (set) / `/profile init <name>` (create) — via `ProfileSource`
- `/note` (list) / `/note init <name>` (create) — via `NoteSource`
- `/save` (list) / `/save <name>` (persist) and `/resume` (list) / `/resume <name>` (restore) — via `SessionSource`

**Model-facing tools** — defined in `src/tools.ts` (`tools: Tool[]`) with their
implementations in `src/tools/files.ts`, `src/tools/shell.ts`,
`src/tools/notes-tool.ts`, and `src/tools/subagent.ts`; dispatched by name by
the core in `src/core/engine.ts`. To add one, append a definition to `tools`
in `src/tools.ts`, add a handler function in the matching domain module, and
register it in the `toolHandlers` map in `src/tools.ts` (or via
`setToolHandler` when the handler depends on edge services constructed later,
such as the subagent handler's `Client`).

- Files: `list_directory`, `read_file`, `create_file`, `edit_file`,
  `delete_file`, `delete_directory`, `find_files` (recursive regex name match),
  `search_files` (recursive regex content search, file or directory)
- Shell: `run_powershell` (Windows-only, foreground 60s SIGTERM timeout; `background: true` spawns a background process and returns a numeric process id), `wait_for_process` (block on a background process up to a timeout, in ms), `kill_process` (SIGTERM a background process)
- Notes: `list_notes`, `read_note`, `save_note`, `delete_note`
- Subagents: `run_subagent` (runs a subagent — a fresh, isolated conversation with its own profile — to perform a task and return its final result; the subagent can use all the same tools, including `run_subagent`)

## Hard rules (from the architecture invariants)

- **No `process.exit()` anywhere.** Termination happens when the event loop drains; set `process.exitCode` instead. `process.exit()` truncates buffered stdout through pipes.
- **The core (`src/core/`) is pure.** No `node:` imports, no `console`, no `process`, no globals. Same input → same output.
- **No `throw` in core paths.** Errors are the structured `Result<T>` / `ViseError` union from `src/core/errors.ts`. All display formatting belongs in `src/output/format.ts`.
- **Dependency arrows point edge → core only.** `client/llm.ts` is the sole module that performs network I/O; `src/tools.ts` (definitions + registry) and the handler modules under `src/tools/` are the edge implementation of the core's `Tool`/`ToolRunner` types.
- **Explicit `.ts` extensions on all imports** (`allowImportingTsExtensions`), ESM throughout.
- **Size limits:** files < 500 code lines, functions < 100 lines. Split at a natural seam when approaching the limit.

## Current-state notes (code lags the architecture doc)

- `index.ts` is still fused entry+driver+readline wiring. `src/driver/stream.ts` holds the streaming display state machine (`StreamDisplay`, the `onToken`/`onThinking`/`onPromptProgress` callbacks the core threads). There is no `src/cli.ts` yet — the TTY/pipe split is the main outstanding refactor. Don't add TTY/pipe special-casing into `index.ts`.
- `src/core/engine.ts` mutates the `messages` array in place by design; it's a documented side channel, not a bug.
- `RECENT_TURNS_TO_KEEP` in `src/repl/session.ts` and `MAX_TOOL_ROUNDS` in `src/core/engine.ts` are the compaction/tool-loop bounds.
- `API_KEY`, `URL`, `MODEL` are hardcoded constants in `src/client/llm.ts` (no env config by design — local-only tool).
- **Profiles:** `/profile <name>` loads a `.md` file from the `profiles/` directory and appends its text as a user message to the conversation (an empty profile file appends a clearing instruction instead); `/profile init <name>` creates a new profile with a placeholder body. The system message is never modified (invariant #6). The `ProfileSource` interface is owned by the core (`src/repl/session.ts`); the edge (`index.ts` `FileProfileSource`) does the `node:fs` I/O, which is shared with the subagent handler through `src/profiles.ts`. Same edge-owns-I/O pattern as `ModelController`.
- **Notes:** A per-project store of short facts and how-to procedures, kept in a flat `notes/` directory. Each note is one `.md` file; the filename (minus extension) is the note name, and the first non-empty line is its one-line summary (shown by listing); the rest is the body. Note names are unique. Recall is **all on-demand**: nothing is auto-injected into context — the model reads/writes notes through the `list_notes`/`read_note`/`save_note`/`delete_note` tools when it decides it needs them, and the user sees the same store via `/note` (list) and can create new notes via `/note init <name>`. The shared file I/O lives in `src/notes.ts` (edge). The `NoteSource` interface is core-owned (`src/repl/session.ts`); the edge (`index.ts` `FileNoteSource`) implements it. Same edge-owns-I/O pattern.
- **Initial file structure:** At startup, `src/fs-tree.ts` (edge) builds an indented text tree of the working directory (capped at 5 levels below root or 25 entries, whichever hits first; dotfiles and `.git` excluded). The result is passed to the `Session` constructor as `initialMessage` and injected as the first user message after the system message. The system message is never modified (invariant #6). `index.ts` calls `buildInitialTree(cwd)` once at startup.
- **Pre-turn hooks:** One or more shell commands (configured in `.viserc.json` as `preTurnCommand`) run in parallel before every turn; each hook's output is injected as a user message before the user's input, in config order. **Post-turn hooks:** One or more shell commands (configured in `.viserc.json` as `postTurnCommand`) run in parallel after every successful turn; each hook's output is injected as a user message after the assistant's reply, in config order. Each hook key accepts either a single command string or an array of command strings. The `PreTurnHook`/`PostTurnHook` interfaces are core-owned (`src/repl/session.ts`); the edge (`index.ts` `ShellHook`) spawns `powershell.exe`. Same edge-owns-I/O pattern.
- **Tools:** `/tool` lists the model-facing tools with their enabled state; `/tool <name> enable|disable` toggles one. The full set of tool definitions is always sent to the model regardless of enabled state — disabling a tool does not change the definitions; it only makes the runner report `error: tool <name> is disabled` if the model calls it. Enabling or disabling also injects a user message into the conversation informing the model of the state change. State is in-memory per process only (not persisted). The `ToolController` interface is core-owned (`src/core/engine.ts`); the edge (`src/tools.ts` `ToolSet`) implements it. Same edge-owns-I/O pattern. The four controller/slash-command handlers that depend only on immutable session fields (`reportContext`, `handleModelCommand`, `handleToolCommand`, `handleNotesCommand`) live in `src/repl/commands.ts` to keep `session.ts` under the size limit; `handleProfileCommand` and `doCompact` stay in `Session` because they mutate conversation state.
- **Subagents:** `run_subagent` runs a subagent — a fresh, isolated conversation with its own system message and profile — to perform a task and return its final assistant text. The subagent receives the same `ToolRunner` and `Tool[]` as the parent, so it may in turn call `run_subagent` and spawn its own subagents. The `profile` argument is required: `"default"` resolves to a built-in constant profile, any other name is loaded from `profiles/<name>.md` via `ProfileSource` (the same edge I/O as `/profile`). The core `runSubagent` (`src/core/engine.ts`) is pure and delegates to `runTurn`; the edge handler (`src/tools/subagent.ts` `makeSubagentHandler`) does the `ProfileSource` I/O and is registered via `setToolHandler` in `index.ts` (because its handler depends on the `Client` and `ProfileSource`, which are constructed there).
- **Sessions:** The conversation can be saved and resumed. One `.json` file per saved session under `sessions/`; the filename (minus extension) is the session name. The fixed crash-recovery snapshot is written as `auto.json` after every successful turn (`Session.saveSession`, called from `handleLine`; I/O errors are swallowed so a save failure never interrupts the turn). `/save <name>` persists the current conversation under a named file, `/resume <name>` replaces the live conversation with a saved body while keeping the live system message at index 0 (invariant #6) and restoring the saved `activeProfile`. `auto` is a reserved name — users cannot save under it. The shared file I/O lives in `src/sessions.ts` (edge); the `SessionSource` interface is core-owned (`src/repl/session.ts`); the edge (`index.ts` `FileSessionSource`) implements it. Same edge-owns-I/O pattern.
- **Streaming:** the model reply streams token-by-token, always on for normal user turns. The core (`Client.chat` / `runTurn`) threads optional `onToken`/`onThinking`/`onPromptProgress` callbacks as side channels — the core never does the I/O itself. The edge (`LlmClient`) performs the SSE parsing/accumulation; the driver (`index.ts`) constructs a `StreamDisplay` (`src/driver/stream.ts`) and passes its bound callbacks. `StreamDisplay` owns all mutable streaming state: `mdLineBuffer` (per-line markdown buffer), `mdInFence` (code fence state), and the progress counters. `LineResult.streamed` tells the driver the reply text was already written, so it emits only the trailing newline instead of re-printing. Compaction/`summarize` calls pass no `onToken`, so they are not streamed. Streaming coverage lives in `test/` (`engine.test.ts` for `runTurn`/`summarize`, `session.command.test.ts` for the `Session` streaming flag, `llm.test.ts` for the `streamChat` SSE parser); `streamChat` is exported from `llm.ts` specifically so it can be unit-tested with a synthetic stream.
- **Markdown rendering:** `src/output/markdown.ts` provides `renderLine(line, inFence): [string, boolean]` — a pure per-line state machine that applies terminal styling to markdown. `StreamDisplay` (`src/driver/stream.ts`) buffers tokens in `mdLineBuffer`, splits on `\n`, and calls `renderLine` for each completed line; `mdInFence` tracks code fence state. When `result.streamed` is true and the buffer is non-empty, the final partial line is flushed through `renderLine` before the trailing newline. Styling: headings → bold, blockquotes → dim, code fences → dim, list items → indented, inline code → cyan, bold spans → bold, links → cyan label + dim url. Pipe mode (no TTY) emits no ANSI codes (handled by `color.ts` `isEnabled()`).

## Environment

- The LLM is a **local llama.cpp server** at `http://localhost:8080` (OpenAI-compatible API).
- **Do not start a second `llama-server` instance if one is already running** — it causes memory issues. Check port 8080 first.
- `run_powershell` in `src/tools/shell.ts` hardcodes `powershell.exe` with a 60-second SIGTERM timeout for foreground commands. This is a Windows-only tool; there is no shell tool for other platforms. Background processes (started with `background: true`) are tracked in an in-process registry and reached by numeric id via `wait_for_process` and `kill_process`; they are not subject to the foreground timeout.

## Pitfalls

- A single large `read_file` tool result can blow the context window — tool output is unbounded (no truncation/pagination yet).
- `toolRunner.run` returns ` error: unknown tool ${name}` as a plain string, not a `ViseError` variant. Keep it that way until structured tool errors land (see "Future Work" in ARCHITECTURE.md).
- `contextMax()` must be queried live per model, never cached — window sizes differ per model.
- A 200 response with a non-JSON (e.g. plain-text) body now surfaces as a `malformed` error (`stream returned no data`) instead of a `network` error — a deliberate, more accurate classification now that the client always requests `stream: true`.
