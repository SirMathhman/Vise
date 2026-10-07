# Vise — Agent Instructions

Vise is an interactive LLM chat REPL written in TypeScript on the Bun runtime.
Full design rationale, invariants, and target layout live in [ARCHITECTURE.md](ARCHITECTURE.md) — read it before making structural changes.

## Commands

| Task       | Command             | Notes                                                                                                                                          |
| ---------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Run        | `bun run index.ts`  | Entry point. No build step — Bun transpiles TS on the fly.                                                                                     |
| Web UI     | `bun run web`       | Starts the Bun HTTP/WebSocket server at `http://localhost:3000` by default. Set `PORT` to override.                                            |
| Web dev    | `bun run dev:web`   | Builds the browser bundle, rebuilds it when `web/src/` changes, and watches/restarts the Bun server.                                           |
| Install    | `bun install`       | Server and core have zero runtime deps; the only runtime deps are `marked` and `dompurify`, bundled into the web UI (`web/src/markdown.ts`), and `playwright-core`, used only by the `browser_run_code` runner.   |
| Type-check | `bunx tsc --noEmit` | Server/core/tests (adds the DOM lib for the web tests; excludes `web/`). Browser code: `bun run typecheck:web` (`web/tsconfig.json`, DOM lib). |
| Lint       | `bun run lint`      | ESLint with typescript-eslint. Config in `eslint.config.js`.                                                                                   |
| Test       | `bun test`          | Bun's built-in `bun:test` runner; suites live in `test/`.                                                                                      |

## Surface (product features an agent touches)

Two surfaces an agent commonly edits. The list below is a quick reference — the
authoritative definitions live in the source files linked.

**User-facing slash commands** — dispatched in `Session.handleLine`
(`src/repl/session.ts`); help text is rendered by `formatHelp` in
`src/output/format.ts`. To add one, handle it in `handleLine` and add it to
`formatHelp`.

- `/exit`, `/help`, `/context`, `/hooks` (the configured pre/post-turn hook commands from `.viserc.json`) / `/hooks add pre|post "<command>"` / `/hooks remove pre|post <number>` / `/hooks profile <name> [add|remove pre|post "<command>"|<number>]` (global hooks always run; a profile can also own hooks that run only while it is the active profile, in addition to the global ones — stored as `pre:<command>` / `post:<command>` entries of the `hooks:` JSON-array frontmatter line of the profile `.md`, applied by `SessionHooks` in `src/repl/session-hooks.ts`, re-read before every turn and workflow; the web hooks panel edits the global hooks and the profile editor edits a profile's own) (edits apply to the running session at once and are saved to `.viserc.json` through `HookSource`; the web UI "hooks" panel edits them too, via `hooks_get` and the same `/hooks` lines; one process-wide `HookStore` in `src/edge-sources.ts` holds the live hook arrays shared by every web connection, saves atomically, and its `onChange` makes the server push a `hooks` message to every open panel), `/compact`, `/new` (fresh conversation; the old one stays auto-saved, the active profile is re-applied; web UI "new" button)
- `/model` (list) / `/model <name>` (switch) — via `ModelController`
- `/burst` (status) / `/burst on|off` — burst mode: think once to plan, then tool calls run with a calls-only grammar (no thinking) until the model emits `<done/>`, a tool returns `error:`, or its tool-name probability is below `BURST_MIN_CONFIDENCE`; handled in `runTurn` via `TurnCallbacks.burst`
- `/tool` (list, grouped by category) / `/tool <name|category> enable|disable` (a category toggles its whole group, including tools that start disabled such as `browser_run_code`) — via `ToolController`
- `/profile` (list) / `/profile <name>` (set) / `/profile init <name>` (create) — via `ProfileSource`; `/profile <name> tools [a,b|all]` shows/sets a tool whitelist stored as `tools:` frontmatter in the profile `.md` (applied on switch via `ProfileToolGate`, prior tool states restored on leaving; web UI "profiles" panel edits it)
- `/note` (list) / `/note init <name>` (create) — via `NoteSource`
- `/workflow` (list) / `/workflow <name> [input]` (run) / `/workflow init [--global] <name>` (create) — via `WorkflowSource`; JSON files live under `.vise/workflows/` or `~/.vise/workflows/`
- `/save` (list) / `/save <name>` (name the current session and save it), `/resume` (list, shows name and uuid) / `/resume <id>` (restore; a unique id prefix works), `/delete <id>` (delete) — via `SessionSource`. Sessions are stored as `.vise/sessions/<uuid>.json` with the display name inside the file; commands never take the name

**Model-facing tools** — defined in `src/tools.ts` (`tools: Tool[]`) with their
implementations in `src/tools/files.ts`, `src/tools/shell.ts`,
`src/tools/notes-tool.ts`, `src/tools/subagent.ts`, `src/tools/ask-user.ts`,
and `src/tools/self.ts`; dispatched by name by
the core in `src/core/engine.ts`. To add one, append a definition to `tools`
in `src/tools.ts`, add a handler function in the matching domain module, and
register it in the `baseHandlers` map in `src/tools.ts` (or pass it as an
`extra` handler to `createToolRunner` in `index.ts` when the handler depends
on edge services constructed later, such as the subagent handler's `Client`
or the `ask_user` handler's `RlUserPrompter`).

- Files: `list_directory`, `read_file`, `create_file`, `edit_file`,
  `delete_file`, `delete_directory`, `find_files` (recursive regex name match),
  `search_files` (recursive regex content search, file or directory)
- Shell: `run_powershell` (Windows-only, foreground 60s SIGTERM timeout; `background: true` spawns a background process and returns a numeric process id), `wait_for_process` (block on a background process up to a timeout, in ms), `kill_process` (SIGTERM a background process)
- Notes: `list_notes`, `read_note`, `save_note`, `delete_note`
- Subagents: `run_subagent` (runs a subagent — a fresh, isolated conversation with its own profile — to perform a task and return its final result; the subagent can use all the same tools, including `run_subagent`)
- User interaction: `ask_user` (pauses the turn, prompts the user with a question and optional predefined choices, and returns the user's answer as the tool result; the user may pick a choice or type a free-form reply; `multi_select: true` lets the user select multiple choices, separated by commas)
- Browser: `browser_open`, `browser_tabs`, `browser_navigate`, `browser_read` (page text plus an outline of interactive elements tagged with refs e1, e2, ...), `browser_click`, `browser_hover`, `browser_drag`, `browser_type` (text and/or a key), `browser_handle_dialog`, `browser_run_code` (disabled by default — `RISKY_TOOLS` in `src/wiring.ts`; enable with `/tool browser_run_code enable` — because the snippet runs with the full privileges of the user; a Playwright snippet with `page` in scope; runs in a separate `node` process, `src/browser/playwright-runner.mjs`, because Playwright's CDP transport does not work under Bun — `node` must be on the PATH; `playwright-core` is a runtime dependency used only by that runner) (an integrated headless Edge/Chrome driven over CDP; handlers in `src/tools/browser.ts` depend only on the `BrowserBackend` interface in `src/browser/types.ts`, two implementations: `ChromiumBackend` (CDP; the terminal default in `src/wiring.ts`) and `FirefoxBackend` (WebDriver BiDi, `src/browser/{bidi,bidi-actions,bidi-view,firefox}.ts`: launches a headless Firefox on a private profile, or attaches by port to a Firefox the user started with `--remote-debugging-port` and then leaves it running; no screencast exists in BiDi so the live view polls screenshots; `browser_run_code` is unsupported there; Firefox allows one BiDi client at a time). The web server shares one `SwitchableBrowser` (`src/browser/switchable.ts`) whose engine is the global setting in `~/.vise/browser.json` (`src/browser/settings.ts`), changed from the settings panel's "browser" tab via the `browser_settings_get`/`browser_settings_set` messages (switching closes the running browser); backends are constructed only in `src/wiring.ts` and `src/browser/switchable.ts`; launched-browser profile/process helpers are shared in `src/browser/processes.ts`; the web server shares one browser across connections and the workspace shows it live via the `browser_*` WebSocket messages in `src/web/browser-bridge.ts`; the frontend must `close()` the browser on shutdown, and the next launch reaps browsers orphaned by a crashed run)
- Tool search: `search_tools` (looks up the full signature of a deferred tool by keyword or exact names). Only the core tools (files, `run_powershell`, `ask_user`, `search_tools`; `CORE_TOOLS` in `src/tools/search-tools.ts`; tool definitions live per domain in `src/tools/defs/`, composed in `src/tools.ts`) are fully described in the system prompt; every other `Tool` is flagged `deferred` and appears there as a name plus a one-line summary, grouped under its `category` (set per definition group in `src/tools.ts`; `search_tools` also accepts a bare category name to return the whole group; `/tool`, the web tools panel and the profile editor list tools grouped by category too). There is deliberately no "call tool" tool: calls are parsed from the model's text and the grammar already allows every enabled tool by name. To add a tool that should always be visible, add it to `CORE_TOOLS`.
- Self: `self` (reports the agent's own live state — backend, active model, working directory, context-window fill, active profile, and pre/post-turn hook commands — so the model can confirm which model and profile it is acting as or how full its context is)

## Hard rules (from the architecture invariants)

- **No `process.exit()` anywhere.** Termination happens when the event loop drains; set `process.exitCode` instead. `process.exit()` truncates buffered stdout through pipes.
- **The core (`src/core/`) is pure.** No `node:` imports, no `console`, no `process`, no globals. Same input → same output.
- **No `throw` in core paths.** Errors are the structured `Result<T>` / `ViseError` union from `src/core/errors.ts`. All display formatting belongs in `src/output/format.ts`.
- **Dependency arrows point edge → core only.** `client/llm.ts` is the sole module that performs network I/O; `src/tools.ts` (definitions + registry) and the handler modules under `src/tools/` are the edge implementation of the core's `Tool`/`ToolRunner` types.
- **Explicit `.ts` extensions on all imports** (`allowImportingTsExtensions`), ESM throughout.
- **Size limits:** files < 500 code lines, functions < 100 lines. Split at a natural seam when approaching the limit.

## Current-state notes (code lags the architecture doc)

For detailed module descriptions and the edge-owns-I/O pattern, see
[ARCHITECTURE.md](ARCHITECTURE.md). The notes below capture only what is
**not** in that document or is non-obvious from reading the code.

- `src/wiring.ts` exports `createEdgeSession`, the shared factory for the LLM client, edge data sources, tool runner, and `Session`. Both `index.ts` (`TerminalDriver`) and `src/web/server.ts` use it. Keep transport-specific behavior in the respective driver, not in shared wiring or the core.
- `index.ts` is thin terminal wiring; the interactive surface lives in `src/driver/terminal.ts`. The web frontend is served by `src/web/server.ts` (entry `src/web/main.ts`); TypeScript sources live in `web/src/` and `bun run web` builds them to `web/dist/` before serving. There is no `src/cli.ts` yet. Don't add TTY/pipe special-casing into `index.ts`.
- **Session root:** a session is rooted at one directory for its whole life. The terminal roots it at the working directory it was started in; a web connection takes it from the page's `?root=<absolute path>` query (default: where the server started) and the server never moves it (`src/web/roots.ts` `RootRegistry`; `createEdgeSession({ root })`). Tools resolve relative paths against the root, `run_powershell` and hooks run in it, and notes/profiles/sessions/`.viserc.json` live under it (`dataDirFor(root)` — the module-level `dataDir` is only the terminal default). The web explorer API (`/api/fs`, `/api/file`) takes the page's `root` and serves only roots with an open session. The top bar's ☰ menu ("Start a new session": "Open folder…" or "No folder", above the saved sessions) asks the server to show the OS folder chooser (`POST /api/pick-folder`, a web page cannot learn a folder's absolute path) and opens the choice as a new session in the same tab (page navigation). Roots are not a sandbox: absolute paths still work in tools. **No-folder sessions:** `createEdgeSession({ noFolder: true })` (terminal `--no-folder`, web `?root=none` / the top bar "no folder") have no working directory: the tools flagged `requiresFileSystem` (the `files` and `shell` categories and `browser_run_code`; `isFileSystemTool` in `src/tools.ts`) are removed from the tool list, prompt, grammar and runner, and the system message says there is no file system. Their profiles, notes, sessions, workflows and hooks live in a generated directory (`noFolderRoot`, `~/.vise/no-folder`), shared by all no-folder sessions; the web file tree is hidden. Trust model: any local process can open a session on any directory (loopback + Host/Origin checks only), and a root's `.viserc.json` hooks run commands, so only open folders you trust.
- **Web UI layout:** a top bar holds menu-style items — `files` (toggles the workspace side view), `sessions` and `settings` (dropdown panels); the header below it keeps the model/profile/reasoning selects, `tools`, `burst`, status, stop and new. The settings panel has tabs (`profiles` editor, `hooks`); new global configuration belongs in a settings tab. The dropdown panels (tools, sessions, settings) are registered in one group in `web/src/panel-switch.ts` (`registerHeaderPanels`): at most one is open, buttons get `aria-expanded`/`aria-controls`, Escape closes them, and each panel supplies what to refresh on open. A new dropdown panel must register there instead of toggling its own `hidden` class. The `files` workspace is deliberately outside the group (it is a side view, not a dropdown).
- **Web UI sessions panel:** toggleable panel that lists saved sessions, resumes one (sends `/resume <name>` and clears the chat log), and saves the current conversation (sends `/save <name>`). The browser sends `/save` and `/resume` as regular lines through the existing `handleLine` path — no new core or edge code. See `ui-features.md` for the feature backlog.
- `src/core/engine.ts` mutates the `messages` array in place by design; it's a documented side channel, not a bug.
- `RECENT_TURNS_TO_KEEP` (`src/repl/compaction.ts`) and `MAX_TOOL_ROUNDS` (`src/core/engine.ts`) are the compaction/tool-loop bounds. `COMPACTION_THRESHOLD = 0.9` (`src/repl/session.ts`) drives `maybeAutoCompact()`.
- `API_KEY`, `URL`, `MODEL` are hardcoded constants in `src/client/llm.ts` (no env config by design — local-only tool).
- `src/data-dir.ts`: `dataDirFor(root)` is the per-session data directory (`<root>/.vise`); any per-project store takes the session root and calls it. The module-level `dataDir` (the start directory) is only the terminal default and the shared browser profile location.
- `src/repl/session-dispatch.ts` holds a WIP `dispatch()` that is a structural duplicate of `Session.handleLine`; `handleLine` in `session.ts` is still the live dispatcher. **Do not assume `dispatch()` is the active path.**
- Subagent wiring requires three extra callbacks beyond the core `ToolRunner`/`Tool[]`: `withPreservedSlotCache`, `currentAbortSignal`, and display callbacks. These are only available at the `src/wiring.ts` edge. Forgetting the `currentAbortSignal` wiring means a subagent's in-flight model call won't be interrupted by Ctrl+C.
- **Turn interruption (Ctrl+C):** `terminal: false` makes readline emit `SIGINT` on Ctrl+C rather than consuming it, so the edge owns the behavior. While a turn is in flight, the first Ctrl+C calls `Session.interrupt()`, which aborts the per-turn `AbortController`; at an idle prompt Ctrl+C exits (`exitCode = 130`). Subagents inherit the same `ToolRunner`/`Tool[]`, so their turns are interruptible too.
- **Streaming:** the core threads optional `onToken`/`onThinking`/`onPromptProgress`/`onToolCall`/`onMaxRounds` callbacks as side channels — the core never does I/O. `StreamDisplay` (`src/driver/stream.ts`) owns all mutable streaming state. `LineResult.streamed` tells the driver the reply was already written, so it emits only the trailing newline. Compaction/`summarize` calls pass no `onToken`, so they are not streamed.
- **Tool-call protocol:** `src/client/tool-protocol.ts` renders tool definitions into the system prompt as text and the client sends a per-request GBNF `grammar` (free text that cannot contain the call delimiter, then calls to enabled tools only; llama.cpp ignores lazy-grammar triggers on this endpoint; never the `tools` field) restricting callable names to enabled tools, so toggling a tool never changes the prompt/KV cache. Calls are parsed from `<|tool_call|>{json}<|/tool_call|>` in the reply; `TurnCallbacks.isToolEnabled` carries the enabled state to `LlmClient.chat`.
- **Per-session tool state:** `createEdgeSession` builds its own `ToolSet` and passes it to both the `Session` and `createToolRunner`; there is no module-level tool controller, so web connections never share enabled/disabled state.
- **Lazy `/profile`:** switching profile queues its messages (profile text and tool notice) in `Session.pendingProfile`; each switch discards the previous queue and the last one is flushed into the conversation at the start of the next turn, workflow, or `/save`. Tool enabled-states change immediately.
- **Markdown rendering:** `src/output/markdown.ts` provides `renderLine(line, inFence)` — a pure per-line state machine for terminal markdown styling. Pipe mode (no TTY) emits no ANSI codes (handled by `color.ts` `isEnabled()`).

## Environment

- The LLM is a **local llama.cpp server** at `http://localhost:8080` (OpenAI-compatible API).
- Subagent cache preservation uses llama.cpp's `/slots` save/restore endpoints. These are best-effort and require the server to start with `--slot-save-path`; snapshots are retained under fixed process/nesting-depth/slot filenames in that server-side directory.
- **Do not start a second `llama-server` instance if one is already running** — it causes memory issues. Check port 8080 first.
- `run_powershell` in `src/tools/shell.ts` hardcodes `powershell.exe` with a 60-second SIGTERM timeout for foreground commands. This is a Windows-only tool; there is no shell tool for other platforms. Background processes (started with `background: true`) are tracked in an in-process registry and reached by numeric id via `wait_for_process` and `kill_process`; they are not subject to the foreground timeout.

## Pitfalls

- A single large `read_file` tool result can blow the context window — tool output is unbounded (no truncation/pagination yet).
- `LineResult` is structurally duplicated in three files (`session.ts`, `session-dispatch.ts`, `workflow-commands.ts`). They are mutually assignable via structural typing, but an agent adding a field to `LineResult` must update all copies or rely on structural compatibility.
- `session-dispatch.ts` `dispatch()` is currently unused. If you "fix" `Session.handleLine` by delegating to `dispatch()`, you must also reconcile the duplicated `LineResult` types and ensure `workflow-commands.ts`/`session-dispatch.ts` dispatch paths are the live ones. As it stands, only `handleLine` is live.
- Subagent wiring requires three extra callbacks beyond the core `ToolRunner`/`Tool[]`: `withPreservedSlotCache`, `currentAbortSignal`, and display callbacks. These are only available at the `src/wiring.ts` edge. Forgetting the `currentAbortSignal` wiring means a subagent's in-flight model call won't be interrupted by Ctrl+C.
- `run_workflow`-style turns create their own `AbortController`. Both `handleLine` (normal turns) and `handleWorkflowCommand` create per-turn `AbortController`s and call `setCurrentAbort`/`setCurrentAbort(null)` in a `finally`. A new turn-type command must do the same or interrupt support silently breaks.
- `toolRunner.run` returns ` error: unknown tool ${name}` as a plain string, not a `ViseError` variant. Keep it that way until structured tool errors land (see "Future Work" in ARCHITECTURE.md).
- `contextMax()` must be queried live per model, never cached — window sizes differ per model.
- A 200 response with a non-JSON (e.g. plain-text) body now surfaces as a `malformed` error (`stream returned no data`) instead of a `network` error — a deliberate, more accurate classification now that the client always requests `stream: true`.
