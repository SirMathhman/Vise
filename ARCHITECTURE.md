# Vise — Architecture

This document describes the ideal architecture that `vise` is working toward.
It deliberately points well ahead of the current code. It is not a changelog:
completed work is visible in the git log; this document only describes the
target architecture and the work that remains.

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
index.ts            # terminal entry point: wires the shared edge session to TerminalDriver
src/
  wiring.ts         # shared edge factory: constructs client, sources, tools, and Session
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
    main.ts         # web entry point (`bun run web`)
    server.ts       # Bun HTTP/WebSocket driver; one Session per connection
    files.ts        # workspace-confined read-only handlers for `/api/fs` and `/api/file`
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
  in `index.ts`, backed by `.vise/profiles/*.md` files). Same pattern as
  `ModelController`: core owns the interface, edge does the I/O.
- `PreTurnHook` and `PostTurnHook` are core-owned types (`repl/session.ts`)
  that run configured shell commands before and after every chat turn and
  return their combined output. The edge provides the implementation
  (`ShellHook` in `index.ts`, spawning `powershell.exe` with the command
  from `.viserc.json`). Multiple hooks of the same kind run in parallel;
  each hook's output is injected as its own user message, in config order —
  pre-turn before the user's input, post-turn after the assistant's reply.
  Same edge-owns-I/O pattern as `ProfileSource`.
- `NoteSource` is a core-owned type (`repl/session.ts`) for the `/note`
  command. A note is the project's store of short facts and how-to
  procedures: one `.md` file per note under a flat `.vise/notes/` directory, the
  filename (minus extension) is the note name, the first non-empty line is
  its one-line summary (shown by listing), the rest is the body. Note names
  are unique. Recall is all on-demand — nothing is auto-injected into
  context; the model reads/writes notes through the `list_notes`/
  `read_note`/`save_note`/`delete_note` tools when it decides it needs them,
  and the user sees the same store via `/note` (list) and can create new
  notes via `/note init <name>`. The shared file I/O lives in `src/notes.ts`
  (edge); the `FileNoteSource` in `index.ts` implements `NoteSource`. Same
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
  I/O and calls the core; it is registered in `index.ts` by passing it as the
  `run_subagent` `extra` handler to `createToolRunner` because its handler
  depends on the `Client` and `ProfileSource`.
  Same edge-owns-I/O pattern as `ProfileSource`.
- `ask_user` is a model-facing tool that pauses the turn to ask the user a
  question (with optional predefined choices) and return the answer as the
  tool result. The `UserPrompter` interface is edge-owned (`src/tools/ask-user.ts`)
  — unlike `ProfileSource` or `ToolController`, nothing in the core references
  this type. The edge handler (`makeAskUserHandler` in `src/tools/ask-user.ts`)
  is registered in `index.ts` as the `ask_user` `extra` handler to
  `createToolRunner` because its dependency (`RlUserPrompter`) requires the
  readline interface constructed there. This is the variant of the
  `createToolRunner` extras pattern where a tool handler depends on an
  edge-owned interface rather than a core-owned one.
- Every file stays under 500 code lines and every function under 100 lines;
  when a module approaches that, split it along a natural seam.

Current implementation: `src/wiring.ts` constructs the shared edge services
and `Session` via `createEdgeSession`. `index.ts` wires that session to the
interactive `TerminalDriver`; `src/web/server.ts` is a second driver that
serves `web/` and bridges browser turns and streaming events over WebSocket.
Each web connection receives an independent edge session. The web driver also
exposes a read-only workspace explorer: `src/web/files.ts` confines `/api/fs`
and `/api/file` requests to the working directory, while `web/src/explorer.ts`
renders the directory tree and tabbed file viewer. The web UI is started with
`bun run web` (default port 3000; `PORT` overrides it); `bun run dev:web`
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

## Potential Problems

- **Forced process exit.** Any `process.exit()` anywhere will truncate
  buffered `stdout` when the output is a pipe and can mask real exit codes.
  Audit new code for it; termination must flow through event-loop draining.
- **Stringly-typed errors.** If `throw` or `console.error` with a bare string
  appears in core code, convert it to a structured `Result`/error type before
  the pattern spreads. The client already returns `Result<string>` with
  structured error variants; the remaining surface is the driver formatting
  those variants for display — keep that formatting in `output/format.ts`
  once it exists, not inline in `index.ts`.
- **One file doing every job.** `index.ts` is currently a thin entry
  and driver layer that also hosts the edge service implementations
  (`FileProfileSource`, `ShellHook`, `loadHookCommands`). The transport,
  tool dispatch, engine, and session are already extracted into their
  own modules. What remains is the driver split (TTY vs. pipe) and the
  `cli.ts` surface. As the driver layer splits, those edge service
  implementations move out of `index.ts` into the driver modules that
  construct the `Session`; until then, `index.ts` is their home.
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
  edge function (`buildInitialMessage` in `index.ts`); adding a new section is
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
  never emitted after that event), not in module-level `let`s in `index.ts`.
  The web transcript (`web/src/transcript.ts`) owns the equivalent browser
  ordering: streamed assistant text is finalized before thinking or tool-call
  entries are appended, so the visible log follows server event order.
- **Dynamic model switching and context awareness.** Model switching
  via `/model` changes the active model on the client. Because context
  limits and token usages vary per model, the session must query `contextMax`
  and context usage dynamically with each model rather than caching a static
  limit across model transitions.

## Future Work

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

## Performance

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
