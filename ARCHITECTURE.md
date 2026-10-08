# Vise — Architecture

This document describes the architecture that `vise` is working toward. The
layout and the design sections (settings, packaging, the desktop window,
steering) describe what exists and end with what is still to do; the rest
points ahead of the current code. It is not a changelog: completed work is
visible in the git log. `AGENTS.md` has the file-level details.

## Definitions

- **Vise** — the tool itself: an interactive LLM chat REPL run on the Bun
  runtime. The user types lines; each line is appended to a conversation and
  sent to a local LLM server; the assistant's reply is printed. The name
  evokes a vice: something that grips and holds its subject in place.
- **Line** — a single unit of user input, one line of stdin, terminated by a
  newline.
- **Session** — one running invocation of the tool, from process start until
  clean termination.
- **Core** — the pure evaluation pipeline that consumes lines and produces
  results. The core must know nothing about `process`, `stdin`, `stdout`, or
  any specific transport.
- **Driver** — the thin edge code that adapts a transport (the interactive
  terminal, a pipe, a script file, a future host embedding) to the core.
- **Result** — a structured value the core returns for each line, carrying
  either a successful value or a structured error. The core must not throw.
- **Structured error** — a typed error value that answers four questions:
  what went wrong, where it came from, why it is an error, and what the user
  can do to fix it.

### Invariants

1. The core is pure: same input lines in, same results out. No `node:` imports,
   no globals, no I/O.
2. All I/O lives at the edge. Only the driver touches `process`, `stdin`,
   `stdout`, and `node:readline`.
3. The process never exits via `process.exit()`; termination happens when the
   event loop drains, and exit codes are set with `process.exitCode`. This is
   what guarantees buffered output is always flushed.
4. Dependency arrows point one way only: edge → core. The core never imports
   anything from a driver or from `index.ts`.
5. No module in the core imports `node:readline`, `console`, or `process`.
6. The system message (the first element of the conversation's `messages`
   array) is set once in the `Session` constructor and never modified after
   initialization. This preserves prompt-prefix caching: the LLM server can
   reuse cached KV positions for the system prompt across turns. Profile
   instructions are appended as user messages, not injected into the system
   prompt.

## Structure

Target module layout and dependency direction:

```
index.ts            # terminal entry point: settings, maintenance flags, then terminal-main.ts
src/
  terminal-main.ts  # terminal wiring: readline, TerminalDriver over the shared edge session
  wiring.ts         # shared edge factory: constructs client, sources, tools, and Session
  edge-sources.ts   # edge implementations of the core-owned sources (profiles, notes,
                    # hooks and the live HookStore, the initial context message)
  config.ts         # live settings: the SPEC table and `config.x` reads
  settings-file.ts  # user-level settings file (~/.vise/.env): load, validate, save
  settings-init.ts  # imported first by each entry so settings apply before anything reads them
  maintenance.ts    # --version, --install-extension, --setup-playwright
  version.ts        # build-time VERSION ("dev" from source)
  build-check.ts    # clear error when a build output is missing from source
  extension-assets.ts # the Firefox extension's files, embedded for --install-extension
  note-store.ts, notes.ts, image-store.ts  # edge stores: notes (by scope/category), pictures
  browser/          # BrowserBackend implementations (CDP, WebDriver BiDi, extension link),
                    # page scripts shared by all, the switchable shared browser
  tools/            # tool handlers per domain (files, shell, notes, browser, subagent...) and defs/
  cli.ts            # argument parsing, subcommands, flag definitions
  driver/
    terminal.ts     # interactive TTY driver: prompt, echo, readline wiring
    stream.ts       # streaming display state machine: owns live prompt,
                    # thinking, visible tool-call events, and markdown
                    # buffering; exposes onToken/onThinking/onPromptProgress/
                    # onToolCall plus beginTurn/finish and callback ordering invariants
    pipe.ts         # piped/script driver: read input to EOF, emit results
  client/
    llm.ts          # LLM transport: implements the core's `Client` type,
                    # `ContextSource`, and `ModelController`; wraps fetch,
                    # owns URL/key/model config; the sole module in the tree
                    # that performs network I/O
  core/
    engine.ts       # line -> parse -> dispatch to client -> Result pipeline
    workflow.ts     # pure ordered workflow execution over Client and ToolRunner
    errors.ts       # structured error types and constructors
  output/
    format.ts       # Result -> text for terminal or plain output
    color.ts        # terminal styling: decides whether ANSI SGR codes are
                    # emitted; single source of truth for color availability
    markdown.ts     # per-line markdown-aware terminal styling for streamed
                    # output; pure state machine over one completed line plus
                    # fence state; imports only from color.ts
    tool-line.ts    # pure one-line display of a tool call (icon, name, detail
                    # from arguments); shared by terminal and web
  repl/
    session.ts        # orchestrates: lines in, results out; owns conversation
                      # state (the growing messages array); defines the core-owned
                      # interfaces (ProfileSource, SessionSource, ProfileCommands,
                      # SessionCommands, CompactionSource, etc.)
    commands.ts       # leaf handlers for commands that depend only on immutable
                      # session fields: reportContext, handleModelCommand,
                      # handleToolCommand, handleNotesCommand — plain module-level
                      # functions taking narrow controller/source interfaces
    session-commands.ts # leaf handlers for commands that need mutable conversation
                      # state: handleProfileCommand, handleResumeCommand,
                      # handleSaveCommand, handleDeleteCommand — take
                      # ProfileCommands / SessionCommands facade interfaces
                      # wired by Session via closures
    compaction.ts       # leaf handler for compaction: runCompaction — takes a
                      # CompactionSource interface with the Client and a reset
                      # callback; no I/O, delegates to core's summarize/split
  tools.ts          # edge-provided tool definitions (`Tool[]`) and `ToolRunner`
                    # implementation: all tool I/O (file ops, shell commands)
  sessions.ts       # edge-owned saved-conversation snapshot I/O and validation
  workflows.ts      # edge-owned JSON workflow file I/O and validation
  web/
    main.ts         # web entry point (`bun run web`, vise.exe): settings, maintenance flags,
                    # port choice, server, and in the compiled build the desktop window
    server.ts       # Bun HTTP/WebSocket driver; one Session per connection
    assets.ts       # the page's files (embedded when compiled); the only static paths served
    files.ts        # workspace-confined read-only handlers for `/api/fs` and `/api/file`
    line.ts         # a connection's lines: the turn chain, steering, the held queue
    queue-commands.ts # /steer and /queue, handled at once
    settings-api.ts, notes-api.ts, browser-bridge.ts  # panels' messages, never queued behind a turn
    port.ts         # busy-port fallback
    desktop.ts, window-worker.ts  # the native window (see "Desktop window")
web/
  index.html        # web UI shell
  src/
    app.ts          # browser entry point; compose focused UI modules
    command-completions.ts # pure finite-choice slash-command completion
    socket.ts       # typed WebSocket protocol and connection lifecycle (target)
    panels.ts       # model/profile/tool/session UI state and rendering (target)
    explorer.ts     # read-only file tree and tabbed file viewer over the explorer API
    composer.ts     # input, keyboard navigation, and suggestions (target)
    transcript.ts   # streamed conversation rendering and log operations
    steer-ui.ts, prompt-progress.ts, env-panel.ts, hooks-panel.ts, notes-panel.ts,
    profile-editor.ts  # focused UI modules (steer/queue, llama.cpp prompt bar, settings tabs)
  dist/app.js       # generated browser bundle (not hand-edited)
  styles.css        # web UI styling
```

Dependency direction (arrows point from dependent to dependency):

```
index.ts ──> wiring ──> session ──> engine
src/web/main.ts ──> src/web/server.ts ──> wiring ──> session ──> engine
index.ts ──> driver/terminal.ts ──> session
                                       │        │
                                       │        └──> client/llm  (transport)
                                       │
                                       └────────> output/format
                                       └────────> output/color   # edge: terminal styling
tools.ts ──> engine                  # edge: tool definitions + ToolRunner implementation
tools/* ──> output/color             # edge: subagent handler dims streamed tokens
driver/stream.ts ──> output/markdown # edge: streaming display renders lines
index.ts ──> output/markdown         # edge: driver renders streamed lines with markdown styling
errors.ts is imported by engine, session, output, and client — and by nothing else
```

`output/` is imported by edge modules only (`index.ts`, `tools/*`); the core
never imports from it. `color.ts` is the single place that decides whether
ANSI SGR codes are emitted; it reads `process.env`/`process.stdout` per call
(edge, not core), so it is testable via env mutation and stays pure with
respect to the core's I/O invariants.

Rules:

- `repl/` command handlers follow the facade pattern: the `Session` class
  implements narrow interface objects (e.g. `ProfileCommands`,
  `SessionCommands`, `CompactionSource`) via closures over its own fields;
  the handler modules are plain module-level functions that take those
  interfaces and are free of class-internal references. This keeps
  `session.ts` under the size limit while preserving testability of each
  handler with a stub interface.
- `index.ts` stays a thin entry point: wire argv to a driver and run. It
  should remain under 50 lines and never contain a `for` loop over lines.
- `core/` has zero `node:` imports and is unit-testable with plain assertions.
- `driver/terminal.ts` and `driver/pipe.ts` are siblings sharing the same
  session API; choosing between them is driven by
  `process.stdin.isTTY` / argv, not by special-casing inside the loop.
- `client/llm.ts` is the sole module that performs network I/O. It receives a
  messages array and returns a `Result<AssistantMessage>`, swallowing all HTTP
  and network errors into structured variants. The `Client` and `Tool` types
  are owned by the core (`core/engine.ts`); the edge _implements_ `Client`
  (today `LlmClient`) and provides the `Tool[]` definitions plus a
  `ToolRunner`, so every dependency arrow points edge → core and the core can
  be tested with stubs.

- `ProfileSource` is a core-owned type (`repl/session.ts`) for loading profile
  text at runtime. The edge provides the implementation (`FileProfileSource`
  in `src/edge-sources.ts`, backed by `.vise/profiles/*.md` files). Same pattern as
  `ModelController`: core owns the interface, edge does the I/O.
- `PreTurnHook` and `PostTurnHook` are core-owned types (`repl/session.ts`)
  that run configured shell commands before and after every chat turn and
  return their combined output. The edge provides the implementation
  (`ShellHook` in `src/edge-sources.ts`, spawning `powershell.exe` with the command
  from `.viserc.json`). Multiple hooks of the same kind run in parallel;
  each hook's output is injected as its own user message, in config order —
  pre-turn before the user's input, post-turn after the assistant's reply.
  Same edge-owns-I/O pattern as `ProfileSource`.
- `NoteSource` is a core-owned type (`repl/session.ts`) for the `/note`
  command. A note is the project's store of short facts and how-to
  procedures: one `.md` file per note under `.vise/notes/` (a subdirectory per category; notes directly in it are `default`), the
  filename (minus extension) is the note name, the first non-empty line is
  its one-line summary (shown by listing), the rest is the body. Note names
  are unique. Recall is all on-demand — nothing is auto-injected into
  context; the model reads/writes notes through the `list_notes`/
  `read_note`/`save_note`/`delete_note` tools when it decides it needs them,
  and the user sees the same store via `/note` (list) and can create new
  notes via `/note init [--global] <name> [category]`. A note has a scope: `project` (`.vise/notes/`) or `global` (`~/.vise/notes/`, shared by every project and by no-folder sessions); the tools that act on one note require it. Notes are the standard memory and skill systems consolidated into one store (suggested categories `user-info`, `memories`, `skills`). The shared file I/O lives in `src/notes.ts`
  (edge); the `FileNoteSource` in `src/edge-sources.ts` implements `NoteSource`. Same
  edge-owns-I/O pattern as `ProfileSource`.
- `SessionSource` is a core-owned type (`repl/session.ts`) for saving,
  loading, listing, and deleting conversation snapshots. The edge
  implementation (`src/sessions.ts`) stores one JSON snapshot per name under
  `.vise/sessions/`; snapshots retain the active profile and timestamp.
  Successful turns auto-save to a name derived from the conversation's first
  user message; an initial collision receives a numeric suffix, and later
  auto-saves overwrite that stable name. Manual `/save <name>` creates a
  separate snapshot and uses the same suffix policy on collision. Resuming a
  session continues auto-saving under its existing name. `/save`, `/resume`,
  and `/delete` share this source and command layer. The web sessions panel
  must use these same commands and store for save, resume, delete, and list
  refresh rather than introducing a second persistence path.
- `WorkflowSource` is a core-owned type (`repl/session.ts`) for listing,
  loading, and creating workflows. Workflow JSON lives under
  `.vise/workflows/` and `~/.vise/workflows/`; project workflows shadow
  same-named global workflows. The edge validates and persists definitions in
  `src/workflows.ts`. Pure orchestration in `core/workflow.ts` executes
  instruction steps through normal model/tool turns and explicit tool steps
  through schema-constrained argument generation followed by direct
  `ToolRunner` execution, in order, then requests a final model response.
  llama.cpp's response format constraints are used only on argument-generation
  requests (without native tool definitions), since its automatic tool-call
  grammar cannot be combined with a user grammar in the same request.
- `LlmClient` owns best-effort llama.cpp slot-cache preservation around
  subagent calls. It discovers populated, idle slots through `/slots`, saves
  snapshots by process/nesting depth/slot, and restores them in `finally`;
  this requires the server's `--slot-save-path` option and does not add a
  separate filesystem dependency to Vise.
- `ToolController` is a core-owned type (`core/engine.ts`) for the `/tool`
  command. It lets the user inspect and toggle the model-facing tools. The
  full set of tool definitions is always sent to the model regardless of
  enabled state — disabling a tool does not change the definitions offered;
  it only makes the `ToolRunner` reject invocations of that tool. When a tool
  is enabled or disabled, the `Session` injects a user message into the
  conversation informing the model of the state change. State is in-memory
  per-process only (not persisted), matching the other controllers. The edge
  provides the implementation (`ToolSet` in `src/tools.ts`). Same
  edge-owns-I/O pattern as `ProfileSource`.
- Subagents are run by the `run_subagent` tool. The core `runSubagent`
  (`core/engine.ts`) is pure: it builds a fresh conversation
  (`[system, profile-as-user, task-as-user]`) and delegates to `runTurn`,
  returning the subagent's final assistant text. The subagent receives the
  same `ToolRunner` and `Tool[]` as its parent, so it may spawn its own
  subagents. The subagent's defining instructions come from a profile: the
  `profile` argument is required, `"default"` resolves to a built-in
  constant, and any other name is loaded from `.vise/profiles/<name>.md` via
  `ProfileSource` — the same edge I/O as `/profile`. The edge handler
  (`src/tools/subagent.ts` `makeSubagentHandler`) performs the `ProfileSource`
  I/O and calls the core; it is registered in `src/wiring.ts` by passing it as the
  `run_subagent` `extra` handler to `createToolRunner` because its handler
  depends on the `Client` and `ProfileSource`.
  Same edge-owns-I/O pattern as `ProfileSource`.
- `ask_user` is a model-facing tool that pauses the turn to ask the user a
  question (with optional predefined choices) and return the answer as the
  tool result. The `UserPrompter` interface is edge-owned (`src/tools/ask-user.ts`)
  — unlike `ProfileSource` or `ToolController`, nothing in the core references
  this type. The edge handler (`makeAskUserHandler` in `src/tools/ask-user.ts`)
  is registered in `src/wiring.ts` as the `ask_user` `extra` handler to
  `createToolRunner`; its dependency is the `UserPrompter` the driver passes to
  `createEdgeSession` (`RlUserPrompter` over the terminal's readline in
  `terminal-main.ts`, `WebUserPrompter` in the web server). This is the variant of the
  `createToolRunner` extras pattern where a tool handler depends on an
  edge-owned interface rather than a core-owned one.
- Every file stays under 500 code lines and every function under 100 lines;
  when a module approaches that, split it along a natural seam.

Current implementation: `src/wiring.ts` constructs the shared edge services
and `Session` via `createEdgeSession`. `src/terminal-main.ts` (started by `index.ts`) wires that session to the
interactive `TerminalDriver`; `src/web/server.ts` is a second driver that
serves `web/` and bridges browser turns and streaming events over WebSocket.
Each web connection receives an independent edge session. The web driver also
exposes a read-only workspace explorer: `src/web/files.ts` confines `/api/fs`
and `/api/file` requests to the working directory, while `web/src/explorer.ts`
renders the directory tree and tabbed file viewer. The web UI is started with
`bun run web` (default port 3000, a setting; a busy port falls back to a free one); `bun run dev:web`
rebuilds the browser bundle and restarts the watched server on source changes.
The transport to the LLM remains in `src/client/llm.ts`. The non-TTY
pipe/script driver and `cli.ts` remain future work.

The web driver's successful `result` message may include a formatted `context`
snapshot (`used / window tokens` and percentage). The browser renders the most
recent successful snapshot in a persistent footer, retaining it when a result
does not carry a new snapshot. The server obtains this through the session's
read-only `/context` path after successful lines; context-window limits are
queried live rather than cached across model changes. Keep this status
reporting on the web edge: it is presentation state, not conversation state,
and must not add a user/assistant message or trigger a model turn.

## Session roots

A session is rooted at one directory, fixed when it starts (terminal: the working directory; web: the `?root=` query, validated by `RootRegistry`). The root is a **default, not a sandbox**: it sets where relative tool paths resolve, the cwd of `run_powershell` and hooks, and the data directory (`dataDirFor(root)`). Absolute paths and `..` in tools still escape it. Only the web file explorer confines to the root (realpath containment, and only for roots with an open session). Hooks come from the root's `.viserc.json`, so opening a folder trusts its hooks. The shared browser profile lives under the server start directory, not under any session root. Enforcing confinement for tools would be a future `RootPolicy` at the edge.

## Browser engines

The integrated browser sits behind the `BrowserBackend` interface (`src/browser/types.ts`); tools and the web bridge never see a protocol. `ChromiumBackend` speaks CDP; `FirefoxBackend` speaks WebDriver BiDi (Firefox removed CDP in v129). Page logic that is protocol-independent (the element snapshot and ref scripts in `page-scripts.ts`) is shared; input, evaluation, dialogs, tab events and the live view are reimplemented per protocol. BiDi has no screencast, so the Firefox live view polls `captureScreenshot`. Firefox can be launched by Vise (private profile, killed by profile name on close) or attached to by port (never killed; only one BiDi client may be attached). The web server holds one `SwitchableBrowser` so the engine is a runtime setting rather than a startup flag.

## Firefox extension

Besides the browsers Vise launches itself, the agent can work in the user's own Firefox through an extension (`extension/`). It is deliberately thin: the Bun server keeps the model loop, tools, notes and hooks, and the extension is only UI (the Vise web page in a sidebar) and hands (browser operations in real tabs). The two meet over one WebSocket (`/ext`, requests `{id, op, params}` answered by `{id, ok, result|error}`, plus `{event:"tabs"}`). The server side is `ExtensionBackend`, a third `BrowserBackend` built on the `ExtensionLink` interface that `src/web/ext-hub.ts` implements, so `src/browser/` does not depend on the web layer. A session opened by the sidebar page (`?ui=sidebar`) uses it; other sessions keep their own headless browser. Trust: the extension, not the server, limits the agent to tabs it opened or was handed, and `/ext` accepts only an extension Origin plus a pairing token (a random secret the server keeps and hands only to the Vise page, which passes it to the sidebar, so another extension or local process posing as the extension cannot become the hands) on top of the usual loopback/Host checks. Input is synthetic, so some sites will not respond.

## Settings

One declarative `SPEC` table (`src/config.ts`) describes every tunable:
variable name, default, minimum, group, label, `secret`, `restart`. The live
values, the file loader and validator (`src/settings-file.ts`), the settings
page's "general" tab and `.env.example` all follow it.

- **Live.** Code reads `config.x` at the point of use, never into a module
  constant, constructor field or closure, so a value saved from the page applies
  at once. Only `restart` settings (the port, the page-snapshot limits baked
  into a script shared with the Firefox extension) are read once.
- **Where values come from.** The user-level file `~/.vise/.env` (shared by
  every project, outside any dev directory), then the process environment, then
  the default. The file wins so that a value saved from the page can never be
  silently overridden by a stale launch-time variable. A missing, empty or
  invalid value falls back to the default; Vise never fails to start over a
  setting.
- **Secrets.** The API key is never sent to the page (only whether one is set),
  the file is written owner-only and atomically, a blank key box keeps the saved
  key, and an explicit "clear" removes it.
- **Saves are patches.** The page sends only the fields it changed, so a stale
  page cannot revert another setting; a file that exists but cannot be read is
  never overwritten.
- **Pure core stays pure.** The core receives values as parameters and keeps its
  few constants (`MAX_TOOL_ROUNDS` and friends); only edge code imports
  `config`.

Still to do: show each setting's effective value and source on the page; push a
save to every open settings page (as hooks do); a lint rule against module-scope
`config.*` reads; `config.ts` is bundled into the Firefox extension through
`page-scripts.ts`, so code shared with the extension should take its limits as
arguments instead; and say so on the page when the LLM address changes while a
key is stored.

## Packaging

Vise ships as two compiled executables built by `scripts/build-exe.ts`
(`bun run build:exe`): `vise.exe` (web server and window) and `vise-cli.exe`
(terminal). Everything a build embeds (the page's files, the Firefox extension,
the Playwright runner script, the window library's DLL) is imported with
`type: "file"`; the server serves only the paths in a fixed map
(`src/web/assets.ts`), never a filesystem path derived from the request. Build
outputs (`web/dist`, `extension/dist`) are prerequisites, and running from
source without one fails with the command that creates it
(`src/build-check.ts`). A build's identity is `package version + commit`
(plus `-dirty` for uncommitted changes), stamped as `VISE_VERSION`; compiled
versus source is decided by that one flag, and anything extracted to disk
(`~/.vise/runtime/<version>`) is keyed by it and superseded folders are pruned.
All user state lives outside the executable (`<project>/.vise`, `~/.vise`),
so updating means replacing it; `--install-extension` and `--setup-playwright`
refresh the pieces that cannot live inside it.

Still to do: serve assets with a content-hash ETag so a replaced executable
never shows a stale page; have the extension report a version mismatch with its
server; sign the executables after the header patch (the patch invalidates any
earlier signature).

## Desktop window

The compiled `vise.exe` shows Vise in its own native window instead of a
browser tab. The server keeps the main thread; the window runs on a worker
thread (`src/web/window-worker.ts`) because the webview library's `run` blocks
until the window closes. The worker binds the WebView2 DLL with `bun:ffi` and
reports typed events (`ready`, `closed`, `failed`; `src/web/desktop.ts`).
Closing the window shuts the server down and the program ends; a window that
cannot start (WebView2 runtime missing, DLL not loading, no window within 10
seconds) is fatal and visible (a message box, exit code 1), so Vise never runs
unseen. `vise.exe` is a GUI-subsystem program (the build patches the PE header),
so it has no console: console output goes to `~/.vise/vise.log` and the
maintenance flags print to the terminal that started it or to a redirect.
`--no-window` serves only, for a browser; `vise-cli.exe` is unchanged.

**Server location is a preference, not an identity.** A busy port never stops
startup: the server takes the next free port (any free one if none is near),
shows a note in the page, and the Firefox extension finds it again by probing
`/api/vise-hello` on its configured port and the 100 above. The port is chosen
in settings (restart-only).

## Steering and queueing

A message sent while a turn runs is either **steering** or **queued**; the
terminal has no input mid-turn, so both are web features. Steering is added to
the conversation as the user's words before the model's next round
(`NoticeQueue`, drained by the round hook, never between a tool call and its
result); words the turn ended without reading run as turns of their own. A queued
line (`qid` on the `line` message) waits for everything before it, including
automatic goal continues, is listed by the server (`queue` message) and can be
removed until it starts. `/steer` and `/queue` act at once, never behind the
turn. The turn-admission state is spread over `web/line.ts`,
`web/queue-commands.ts` and `web/server.ts`; see Future Work for the
single-module target.

## Potential Problems

- **Forced process exit.** Any `process.exit()` anywhere will truncate
  buffered `stdout` when the output is a pipe and can mask real exit codes.
  Audit new code for it; termination must flow through event-loop draining.
- **Stringly-typed errors.** If `throw` or `console.error` with a bare string
  appears in core code, convert it to a structured `Result`/error type before
  the pattern spreads. The client already returns `Result<string>` with
  structured error variants; the remaining surface is the driver formatting
  those variants for display — keep that formatting in `output/format.ts`
  once it exists, not inline in the entry point.
- **One file doing every job.** Done for the entries: `index.ts` and
  `src/web/main.ts` only apply settings, handle maintenance flags and hand over;
  the edge service implementations live in `src/edge-sources.ts` and the shared
  wiring in `src/wiring.ts`. What remains is the driver split (TTY vs. pipe)
  and the `cli.ts` surface.
- **Pure core vs. network I/O.** The core's fundamental operation is an HTTP
  round-trip, which is I/O. The resolution is the `Client` interface: the
  core owns the _type_, the edge provides the _implementation_. Do not
  put `fetch` in `core/engine.ts`; do not put HTTP logic in `driver/`. If a
  future driver (e.g. a mock client for tests) needs to swap the transport,
  that is the mechanism — not a new module at the core level.
- **Unbounded conversation.** The `messages` array grows with every turn and
  has no size cap; on a local llama.cpp server with a finite context window it
  eventually overflows. This is addressed by compaction: the session
  summarizes the older portion of the conversation (via the core's
  `summarize`/`splitForCompaction`) and keeps only the most recent turns
  verbatim, on demand (`/compact`) and automatically when the server-reported
  token count nears the window. The core's `splitForCompaction` is pure; the
  summarize round-trip goes through the `Client`, so no I/O is added to the
  core.
- **Unbounded tool output.** A tool result like `read_file` returning full
  file contents of arbitrary length can grow the `messages` array without
  bound, not just from conversation length. On a local llama.cpp server with
  a finite context window, a single large `read_file` can exceed the model's
  context and produce a truncated or garbled response. The core's
  `messages` array has no size cap; bounding tool output (truncation,
  pagination, or a max-byte limit) is a future concern that belongs in the
  session or engine layer, not in the tool implementation itself.
- **Unbounded subagent recursion.** `run_subagent` receives the same
  `ToolRunner` and `Tool[]` as its parent, so a subagent can spawn its own
  subagents with no depth limit. Each level runs a full tool loop, so
  recursive spawning multiplies context usage quickly on a local server.
  The only bounds are `MAX_TOOL_ROUNDS` per turn and the model's context
  window; a depth cap or cost-aware guard is a future concern.
- **Unbounded line input.** A piped file is unbounded. The core must process
  lines streaming, one at a time, and never buffer the whole input in memory.
- **Session snapshot durability and deletion races.** Named snapshots are
  user data. Persistence must preserve the reserved auto-save contract, reject
  path traversal, report missing names accurately, and avoid corrupting a
  usable snapshot if a write is interrupted. If multiple drivers or processes
  mutate the same project store concurrently, define an explicit consistency
  policy rather than silently relying on process-local serialization.
- **Auto-save name ownership.** An internal command such as `/workflow` is not
  the conversation's first user message and must not claim its derived
  auto-save name before a user message exists. Keep workflow-turn persistence
  while deferring first-name selection until the first conversational input;
  otherwise a command can give the session a surprising name that remains
  stable for all later turns.
- **Initial context seeding.** At startup the edge composes the conversation's
  first user message (after the system message) from the working directory: a
  capped directory tree, the project's `AGENTS.md` agent-instructions file when
  present, a comma-separated list of available profile names when the
  `.vise/profiles/` directory has entries, and a list of available notes
  (name — summary) when the `.vise/notes/` directory has entries. Each section
  is conditionally included only when non-empty. All runtime data stores
  (profiles, notes, sessions) live under a single `.vise/` directory to keep
  the working directory clean; the dot name also excludes `.vise/` from the
  startup directory tree (dotfiles are skipped). The composition is a named
  edge function (`buildInitialMessage` in `src/edge-sources.ts`); adding a new section is
  a two-line addition inside that function, not a new nested ternary at the
  call site. The `Session` receives the result as an opaque `initialMessage`
  string and injects it once; it never re-reads the directory, files, or
  listings. All reads are best-effort at the edge (invariant #2): a missing or
  unreadable `AGENTS.md`, an empty `.vise/profiles/` or `.vise/notes/`
  directory, is silently omitted, matching the tree's "unreadable directories
  are silently skipped" behavior and the profile "absent → empty string"
  sentinel. Because this is a one-shot value built at construction, no
  core-owned `Source` interface is needed — the session takes an opaque string,
  not a queryable edge service.
- **TTY-only assumptions.** Today the readline interface hard-codes
  `terminal: false` and assumes a TTY. The driver split exists precisely so
  TTY and non-TTY paths are tested independently; do not re-couple them.
- **Blocking tools.** Tool implementations run child processes and
  file I/O. `ToolRunner.run` is async to prevent blocking the REPL event
  loop, but long-running commands (e.g. unbounded child processes) can
  still stall turn completion. Bounding execution time and supporting
  cancellation/interrupts remain essential driver/engine concerns.
- **Implicit global state.** Session state (conversation state, interrupt
  handling) must live in the session object, not in module-level `let`
  bindings, or the core becomes untestable and un-reentrant. The streaming
  display state is the live instance of this: prompt/thinking counters, tool
  invocation events, and the markdown line buffer (fence state) are driven
  by callbacks (`onToken`/`onThinking`/`onPromptProgress`/`onToolCall`) that
  all write to the same stdout stream. That state must live in a single
  driver object (e.g. `driver/stream.ts` `StreamDisplay`) that owns the
  cross-callback ordering invariants (e.g. flush any partial content line
  before a counter or tool event starts a fresh line, so buffered content is
  never emitted after that event), not in module-level `let`s in an entry point.
  The web transcript (`web/src/transcript.ts`) owns the equivalent browser
  ordering: streamed assistant text is finalized before thinking or tool-call
  entries are appended, so the visible log follows server event order.
- **Dynamic model switching and context awareness.** Model switching
  via `/model` changes the active model on the client. Because context
  limits and token usages vary per model, the session must query `contextMax`
  and context usage dynamically with each model rather than caching a static
  limit across model transitions.

## Future Work

- **One labelled model-call channel.** Every model call (reply, goal derivation,
  goal check, progress check, compaction summary, workflow step, subagent round)
  is a `ChatRequest` object `{ messages, tools?, schema?, act?, signal?,
  purpose }` handed to `Client.chat`, replacing the nine positional parameters.
  Prompt progress and streaming do not travel as per-call callbacks threaded
  through core helpers: the client owns a per-session `CallObserver` sink, and
  every call reports `{ call, purpose, tokens... }` to it, including
  non-streaming `act` calls (which report start and end with the measured
  prompt size). The observer allocates the call number, so numbering covers
  every request, and displays render one labelled bar per purpose ("checking
  the goal", "reading", "compacting"). Core helpers then need no progress
  parameter at all, and a new call site cannot be silently invisible.
- **One turn-admission state machine per conversation.** Which line runs, which
  are held, and which steers are pending is a single piece of state with
  explicit states (`idle`, `running`, `draining`) and transitions: submit,
  hold, unhold, steer, finish. It lives in one module (`repl/turn-queue.ts`,
  pure, no I/O) that the web connection and the terminal both drive, instead
  of `running`/`chain`/`held` booleans and arrays mutated from `web/line.ts`,
  `web/queue-commands.ts` and `web/server.ts`. A steer is accepted or refused
  atomically with the transition that ends the turn, so no steer can land
  after the last drain and wait for an unrelated later turn. The terminal gets
  `/steer` and `/queue` from the same module, and the browser's `steer-ui.ts`
  mirrors only the `queue` message, never its own copy of the rules.

- **Pictures are blobs referenced by id.** Done: a `Picture` carries a content
  hash, type (sniffed from the bytes) and size; the bytes live in the shared
  `ImageStore` and are resolved to a data URI only when a request is built.
  Still to do: a per-root store behind a port in `repl/ports.ts`, sweeping
  unreferenced files when a session is deleted, letting compaction drop a
  picture's bytes while keeping its reference, an opt-out from persisting
  screenshots of sensitive pages, and collecting pictures per tool call (the
  result carrying them) instead of from a shared outbox, so concurrent tool
  calls could not take each other's pictures.

- **Vision tools are absent, not disabled.** While the active model cannot see
  images, `view_image` and `browser_screenshot` should not be listed in the
  prompt at all (the grammar already excludes disabled tools); changing the
  model rebuilds that section once, at a point where the cache is invalid anyway.

- **Tool display metadata lives on the tool.** Done for the label and the icon: a `Tool` carries `display: { label, icon }`, tests require every tool to have one, and the display code takes a lookup built from the definitions (`src/tools/display.ts`). Still to do: the arguments worth showing and the sensitive ones (`SHOWN` and `SENSITIVE` in `output/tool-line.ts` are still name-keyed), and the same readable names in error messages that name a tool.
- **Structured list payloads for UI panels.** Tool categories (and every other
  list the web UI renders) should reach the browser as typed data, e.g. a
  `{type:"tools", items:[{name,enabled,category}]}` WebSocket message built
  from `ToolController.list()`, not by re-parsing `formatToolList` text.
  `formatToolList` stays terminal-only; the web client stops regexing `[x]`
  headings and `(enabled)` suffixes. Until then the text format is a wire
  protocol and must be pinned by a golden test shared by server and web
  parser. Category names are a closed vocabulary (lowercase, no brackets,
  `other` reserved for uncategorised) validated at registration.
- **Engine (done).** `core/engine.ts` already contains `runTurn`,
  `splitForCompaction`, and `summarize`; it is pure and unit-testable with a
  stub `Client`.
- **Session (done).** `repl/session.ts` already owns the conversation state
  (`messages` array) and handles `/exit`, `/context`, `/compact`, `/model`,
  and turn dispatch. The session owns state; the engine is stateless.
- **Drivers.** Add the pipe/script driver alongside the terminal driver so the
  same session can be driven non-interactively; this is what makes the tool
  scriptable and CI-able.
- **CLI surface.** `cli.ts` with subcommands and flags; `index.ts` shrinks to
  pure wiring.
- **Tool system.** Tool definitions (`Tool[]`) and the `ToolRunner`
  interface (edge provides implementations in `src/tools.ts`, engine
  dispatches by name) are implemented. What remains: structured
  tool-execution errors as a `ViseError` variant (e.g. `kind: "tool"`), not
  string-swallowed into the message; and output bounding (truncation/pagination)
  to prevent single tool calls from exhausting context windows.
- **Model management & configuration.** Model selection via `/model` and
  model enumeration via `GET /v1/models` are now supported at runtime. Future
  work includes model parameter configuration (temperature, top_p), model
  aliasing, and persisting default model selection across invocations.
- **Session state and persistence.** Conversation state (the growing
  `messages` array), interrupt (Ctrl+C) handling, and clean termination state
  are owned by `session.ts`, exercisable without a real TTY. Saved snapshots
  use the edge-owned `SessionSource`; keep storage validation and file I/O out
  of the core. Before supporting concurrent writers or relying on snapshots
  as durable backups, define atomic-write, schema-versioning, and cross-process
  conflict policies.
- **Tests.** Core tests first (pure, fast, no I/O — use a stub `Client`), then
  driver tests against piped input. A core test must never open a real
  stdin/stdout or make a real HTTP call.
- **Lint enforcement.** Keep the configured file/function size limits and
  core import restrictions aligned with the architecture invariants as modules
  are added; browser JavaScript should remain included in lint with its own
  environment globals.
- **Finding things without blind scrolling.** `browser_read` lists only what is
  in the viewport (capped at 200 with the count of what is left out, a modal
  first) while its text covers the whole page. A `browser_find` helper should
  scroll until given text appears, or report the nearest ref and how far away
  it is; `browser_scroll` could end by waiting for lazy-loaded content;
  `SNAPSHOT_SCRIPT` should become a typed function (stringified) with unit
  tests of the cap and the in-view rules; elements inside iframes and shadow
  roots are not handled (`elementFromPoint` sees only their host); a sticky
  header can still cover a click target after the scroll into view; and the
  scrollable-panel scan runs `getComputedStyle` over many elements per snapshot.

- **Page actions are data, not backend methods.** Done for `select`: a
  `PageAction` in `page-scripts.ts` runs through one optional backend
  capability, `runPageAction`, implemented once per protocol and forwarded once
  by `SwitchableBrowser`; the extension builds the script from the named action
  and never runs script text from the server. Still to do: move the other
  widgets (combobox, checkbox/radio, date and contenteditable setters, the
  first step of `uploadFiles`) onto it. Snapshot refs should carry a
  page-generation stamp so a ref from before a re-render fails with "page
  changed, read again" instead of acting on the wrong element; the outline
  should be paged or filtered (by region or field) rather than capped
  silently, and tool results should report repeated identical failures so the
  loop can stop and ask the user.

## Performance

- **The web chat log.** Appending a line, streaming a reply and scrolling must
  cost the same at 100 lines and at 10,000. Measure with `?bench=<lines>` on
  the page (`web/src/bench.ts`, development only): per-line cost, frame time
  while a long reply streams, cost of 50 scroll jumps, DOM size, heap. Done:
  follow the bottom only while reading there, one render per frame with the
  finished part of a long reply rendered once, lazy pictures, no live region.
  The conversation is also kept as data (`web/src/chat-lines.ts`), so the next
  steps need no rewrite: keep only the newest lines mounted (older ones rebuilt
  from the data, a spacer standing for them), then page older history from the
  server by `seq` instead of the 400-line cap. Do not rely on
  `content-visibility` with one guessed height per line: it makes the
  scrollbar jump.

Obvious concerns only — real optimization should be profiler-driven.

- **Throughput of the pipe path is I/O-bound.** The only things that could
  hurt it: per-line allocations in formatting, and any accidental buffering
  of the whole input before processing. Streaming one line at a time keeps
  memory flat in input size.
- **Interactive latency.** The prompt→echo path should have no measurable
  overhead beyond the syscall; if line latency ever becomes noticeable, profile
  before optimizing — the usual suspect is work done synchronously in the
  `line` handler that should have been deferred.
- **Startup.** Keep the entry point's import graph small; the cost of loading
  the CLI surface for a plain REPL session is the one startup cost worth
  watching.
