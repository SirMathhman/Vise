# Vise — Architecture

Design rationale, invariants and layout for `vise`. It describes what exists and, where marked, what is still to do; it is not a changelog (see the git log). `AGENTS.md` is the quick reference with file-level detail and the non-obvious behaviours.

## Definitions

- **Vise** — an interactive LLM chat REPL on the Bun runtime. The user types lines; each is appended to a conversation and sent to a local LLM server; the reply is shown. The name evokes a vice: something that grips its subject.
- **Line** — one unit of user input.
- **Session** — one conversation's live state: the `messages` array, the active profile, settings of the turn loop.
- **Core** — the pure pipeline that consumes lines and produces results. It knows nothing of `process`, `stdin`, `stdout` or any transport.
- **Driver** — the thin edge code adapting a transport (the terminal, the web server) to the core.
- **Result** — a structured value carrying either a value or a structured error. The core does not throw.
- **Structured error** — a typed value answering: what went wrong, where it came from, why it is an error, and what the user can do.

### Invariants

1. The core is pure: same input, same results. No `node:` imports, globals, or I/O.
2. All I/O lives at the edge. Only drivers touch `process`, stdin and stdout.
3. The process never exits via `process.exit()`; it ends when the event loop drains, with `process.exitCode` set. Buffered output is then always flushed.
4. Dependency arrows point edge → core only.
5. No core module imports `node:readline`, `console` or `process`.
6. The system message is set once and never modified, to preserve prompt-prefix caching. Profile instructions and notices are appended as user messages.
7. Every file stays under 500 code lines and every function under 100 (lint); at most 9 `.ts` files directly in a directory. Split along a natural seam.

## Structure

A Bun workspace monorepo. Packages import each other by `@vise/*` name; dependency direction is `apps/*` → `packages/backend` → `packages/core`, with `packages/common` (types and pure data shared by server and page) beneath both and `packages/frontend` as the browser side.

```
index.ts                  # terminal entry: settings, maintenance flags, then terminal-main.ts
packages/
  core/src/               # PURE: engine, goal, goal-trace, workflow, compaction/, call/ (runaway),
                          #   cancel/ (abortable), hooks/, audit types, errors, schemas/ (zod)
  common/src/             # wire messages, ListsSnapshot, semantic types, command table
  backend/src/            # the edge (all I/O)
    wiring.ts             # createEdgeSession: shared factory for client, sources, tools, Session
    terminal-main.ts      # terminal wiring (readline, TerminalDriver)
    edge-sources.ts       # edge implementations of core-owned sources: profiles, notes, hooks
                          #   (live HookStore), the initial context message
    config.ts, data-dir.ts, version.ts, global-prompt.ts, fs-tree.ts
    tools.ts, tools/      # tool registry + ToolRunner; tools/{defs,browser,agent,hooks,semantic}/
    client/               # the only model network layer: llm.ts, model-queries.ts, provider.ts
                          #   (pure), retry.ts, slots.ts, tool-protocol.ts, stream/
    repl/                 # Session, ports.ts, command-catalog.ts, lists.ts, commands/, turn/
    driver/               # terminal.ts, stream.ts (StreamDisplay)
    output/               # pure text formatting: format, color, markdown, tool-line, audit-format…
    stores/               # notes, profiles, workflows, sessions, image-store, semantic/
    db/                   # bun:sqlite: open, migrate; audit/ (audit.db), session/ (vise.db)
    browser/              # BrowserBackend, page-scripts, switchable, extension; chromium/, firefox/
    mcp/                  # MCP client (config, connection, tools, hub, store, command)
    settings/, build/     # ~/.vise/.env loading; build checks, extension assets, maintenance flags
  frontend/               # the web page: index.html, src/ (by feature), styles/, dist/ (generated)
apps/
  web/src/                # Bun HTTP/WebSocket server: main.ts, server.ts, http.ts, assets.ts, port.ts,
                          #   router/, conn/, api/, ext/, desktop/, terminal/, inspect/
  extension/              # Firefox extension (Manifest V2)
  cli/                    # placeholder (no sources)
crates/vise-rs/           # experimental Rust port of the web server (not in the Bun build)
test/                     # sub-directories beside the area they cover; setup.ts is the preload
scripts/                  # build-exe, build-ext, build-icon, dev-web, install-exe, rebuild.ps1
```

Dependency direction:

```
index.ts ──> terminal-main ──> wiring ──> Session ──> engine (core)
apps/web/src/main.ts ──> server.ts ──> wiring ──> Session ──> engine
Session ──> client/llm (transport), output/*
tools.ts ──> engine            # edge: tool definitions + ToolRunner implementation
errors.ts is imported by engine, session, output and client, and by nothing else
```

`output/` is imported by edge modules only; the core never imports from it. `color.ts` alone decides whether ANSI codes are emitted.

### Rules

- **Core owns the type, the edge does the I/O.** `Client`, `Tool`, `ToolRunner`, `ToolController`, `ProfileSource`, `NoteSource`, `SessionSource`, `WorkflowSource`, the turn hooks and `ToolHooks` are core-owned interfaces; the edge implements them (`LlmClient`, `ToolSet`, `FileProfileSource`, `FileNoteSource`, `stores/sessions.ts`, `ShellHook`, `ShellToolHooks`, …), so every arrow points edge → core and the core is testable with stubs. `ask_user`'s `UserPrompter` is the variant with no core type: edge-owned, passed to `createEdgeSession` by the driver (`RlUserPrompter`, `WebUserPrompter`).
- **Facade pattern for `repl/commands/`.** `Session` implements narrow interface objects (`ProfileCommands`, `SessionCommands`, `CompactionSource`…) by closure over its fields; handler modules are plain functions over those interfaces, which keeps `session.ts` under the size limit and each handler testable with a stub.
- **`index.ts` stays thin:** wire argv to a driver and run. The terminal driver and the web server are siblings over `createEdgeSession`; nothing special-cases a surface inside the loop. A pipe/script driver would be a third sibling (not built).
- **`packages/backend/src/client/`** is the sole layer doing model network I/O. `llm.ts` returns `Result<AssistantMessage>`, swallowing HTTP and network errors into structured variants.
- **Edge extras pattern.** A tool whose handler needs services built later (subagent `Client`, `ask_user` prompter) is passed as an `extra` handler to `createToolRunner`.
- **Per-session state.** Conversation, interrupt handling, tool toggles and streaming display state live in objects owned by the session or driver (`Session`, `ToolSet`, `StreamDisplay`), never module-level `let`s. `StreamDisplay` owns cross-callback ordering (flush a partial line before a counter or tool event); the web transcript owns the browser equivalent (finalise streamed text before appending thinking or tool entries).
- **Presentation state is not conversation state.** The web `result` message may carry a formatted `context` snapshot (`used / window`), rendered in a footer from the read-only `/context` path; it adds no message and triggers no turn. Window limits are queried live per model, never cached.

### Notable edge designs

- **Hooks.** Pre/post-turn hooks (`PreTurnHook`/`PostTurnHook`) run configured commands from `.viserc.json` in parallel and inject each output as its own user message (pre before the user's input, post after the reply). **Tool hooks** run around one tool call (`preToolCommand`/`postToolCommand`, matching in the pure `core/hooks/tool-hook-match.ts`, `ShellToolHooks` called by `createToolRunner`): a pre hook exiting 2 vetoes the call, other failures fail open, post output is appended after the too-large spill step; they see `VISE_TOOL_*` env and JSON on stdin, run only for calls that will run, apply to subagents too, and never go through the runner themselves.
- **Notes** are one `.md` file each under `.vise/notes/<category>/` (project) or `~/.vise/notes/` (global); the first non-empty line is the summary. Recall is on-demand through the note tools; only the list is in the startup message. All access goes through `NoteStore`.
- **Sessions** are rows of the project database `.vise/vise.db` (a `sessions` row and its `messages` rows rewritten in one transaction per save, an FTS5 index for `/search`). Turns auto-save under the conversation's id. Schema versions are `PRAGMA user_version` with append-only migrations; one connection per database file is shared by every web connection; storage failures return the `storage` `ViseError`. Old JSON snapshots are imported once, verified by message count, then deleted. There is no second persistence path.
- **Workflows** (`core/workflow.ts`, pure): instruction steps run as normal turns, explicit tool steps via schema-constrained argument generation then direct `ToolRunner` execution, then a final model response. A `profile` step switches profile through the `WorkflowProfiles` port. Target: a step kind as one registered descriptor (validate, pre-run check, run, editor form) instead of an `if` chain repeated in the store validator, runner, availability check and web editor, with profile restore owned by the run scope.
- **Subagents** (`run_subagent`): `runSubagent` (core, pure) builds `[system, profile-as-user, task-as-user]` and delegates to `runTurn`; the edge handler loads the profile and calls it. A subagent gets the parent's `ToolRunner` and `Tool[]`, so it can spawn subagents (bounded only by `MAX_TOOL_ROUNDS` and the window; a depth cap is future work). `LlmClient.withSideSlot` pins its requests to the least recently used slot other than the main one so the main cache is never disturbed; slot save/restore was removed because a restore brings back tokens but not the context checkpoints the model needs, so the next request re-read the whole prompt.
- **Tools toggling** never changes the prompt: all definitions are always offered, disabling only makes the runner reject (and the grammar exclude) the call, and the session tells the model of the change with a user message. State is in-memory per session.
- **Initial context** is one user message built at startup by `buildInitialMessage` (`edge-sources.ts`): a capped directory tree, the project's `AGENTS.md`, profile names and note summaries, each only when non-empty and best-effort (unreadable parts are omitted). The `Session` takes it as an opaque string. All runtime data lives under `.vise/`, which the tree skips.
- **Compaction** summarises the older part of the conversation (`splitForCompaction` pure; the summary goes through the `Client`) on `/compact` and automatically near the window; the verbatim tail and the user's own words are preserved. Tool results over the size limit are saved to a temp store and replaced by their start (`TempStore`, `read_temp`/`search_temp`).
- **Web driver:** `apps/web/src/server.ts` serves the page, bridges turns and streaming events over WebSocket (one independent edge session per connection) and exposes a read-only workspace explorer confined to the session root (`api/files.ts`).

## Session roots

A session is rooted at one directory, fixed when it starts (terminal: the working directory; web: the `?root=` query, validated by `RootRegistry`). The root is a **default, not a sandbox**: it sets where relative tool paths resolve, the cwd of `run_powershell` and hooks, and the data directory (`dataDirFor(root)`). Absolute paths and `..` in tools still escape it; only the web file explorer confines to the root. Hooks and MCP servers come from the root's `.viserc.json`, so opening a folder trusts them. The shared browser profile lives under the server start directory. Enforcing confinement for tools would be a future `RootPolicy` at the edge.

## Browser engines

The integrated browser sits behind `BrowserBackend` (`browser/types.ts`); tools and the web bridge never see a protocol. `ChromiumBackend` speaks CDP; `FirefoxBackend` speaks WebDriver BiDi (Firefox removed CDP in v129). Protocol-independent page logic (the snapshot and ref scripts in `page-scripts.ts`) is shared; input, evaluation, dialogs, tab events and the live view are per protocol. BiDi has no screencast, so the Firefox live view polls screenshots. Vise can launch Firefox (private profile) or attach by port (never killed; one BiDi client only). The web server holds one `SwitchableBrowser`, so the engine is a runtime setting.

## Firefox extension

Besides launched browsers, the agent can work in the user's own Firefox through `apps/extension/`. It is deliberately thin: the Bun server keeps the model loop, tools, notes and hooks; the extension is only UI (the Vise page in a sidebar) and hands (operations in real tabs). They meet over one WebSocket (`/ext`, requests `{id, op, params}` answered by `{id, ok, result|error}`, plus `{event:"tabs"}`). The server side is `ExtensionBackend`, built on the `ExtensionLink` interface that `apps/web/src/ext/ext-hub.ts` implements, so `browser/` does not depend on the web layer. Only a session opened by the sidebar (`?ui=sidebar`) uses it. Trust: the extension limits the agent to tabs it opened or was handed; `/ext` accepts only an extension Origin plus a pairing token (a random secret the server hands only to the Vise page, which passes it to the sidebar) on top of the loopback/Host checks. Input is synthetic, so some sites will not respond.

## Settings

One declarative `SPEC` table (`packages/backend/src/config.ts`) describes every tunable (name, default, minimum, group, label, `secret`, `restart`); the live values, the file loader (`settings/settings-file.ts`), the page's "general" tab and `.env.example` all follow it.

- **Live.** Code reads `config.x` at the point of use, never into a constant or closure, so a saved value applies at once. Only `restart` settings (the port, the snapshot limits baked into a script shared with the extension) are read once.
- **Sources.** `~/.vise/.env` (shared by every project), then the process environment, then the default. The file wins so a value saved from the page is never silently overridden by a stale launch-time variable. A missing or invalid value falls back to the default; Vise never fails to start over a setting.
- **Secrets.** The API key never goes to the page (only whether one is set); the file is written owner-only and atomically; a blank key box keeps the saved key.
- **Saves are patches:** the page sends only changed fields; an unreadable existing file is never overwritten.
- **The core stays pure:** it takes values as parameters and keeps a few constants (`MAX_TOOL_ROUNDS` and friends); only edge code imports `config`.

Still to do: show each setting's effective value and source; push a save to every open settings page (as hooks do); a lint rule against module-scope `config.*` reads; code shared with the extension should take limits as arguments (`config.ts` is bundled into it).

## Packaging

Two executables from `scripts/build-exe.ts` (`bun run build:exe`): `vise.exe` (web server and window) and `vise-cli.exe` (terminal). Everything a build embeds (the page, the extension, the Playwright runner, the window library's DLL) is imported with `type: "file"`; the server serves only the paths in a fixed map (`apps/web/src/assets.ts`), never a path derived from the request. Build outputs (`packages/frontend/dist`, `apps/extension/dist`) are prerequisites, and running from source without one fails with the command that creates it (`build/build-check.ts`). The version is `package version + commit` (plus `-dirty`), stamped as `VISE_VERSION`; compiled versus source is decided by that one flag, and anything extracted to disk (`~/.vise/runtime/<version>`) is keyed by it. All user state lives outside the exe, so updating means replacing it; `--install-extension` and `--setup-playwright` refresh what cannot live inside it. The build renames the live exe aside, so rebuilding while running is safe.

Still to do: serve assets with a content-hash ETag; have the extension report a version mismatch; sign the executables after the header patch.

## Desktop window

`vise.exe` shows Vise in a native window. The server keeps the main thread; the window runs on a worker (`apps/web/src/desktop/window-worker.ts`) because the webview's `run` blocks. The worker binds the WebView2 DLL with `bun:ffi` and reports typed events (`ready`, `closed`, `failed`). Closing the window shuts the server down; a window that cannot start (no WebView2, DLL not loading, none within 10 s) is fatal and visible (message box, exit code 1), so Vise never runs unseen. The exe is a GUI-subsystem program (the build patches the PE header), so console output goes to `~/.vise/vise.log`. `--no-window` serves only; `vise-cli.exe` is unchanged.

**Server location is a preference, not an identity.** A busy port never stops startup: the server takes the next free port, shows a note in the page, and the extension finds it by probing `/api/vise-hello` on its configured port and the 100 above.

## Integrated terminal

A bottom panel (xterm.js) for the user only; the agent keeps `run_powershell`. **The shell belongs to the folder, not the page:** `TerminalRegistry` keeps one shell per session root, shared by every page on the folder, with recent output replayed on open (`Scrollback`, `VISE_TERMINAL_SCROLLBACK_KB`). An unwatched shell stops after `VISE_TERMINAL_IDLE_MINUTES`; shutdown stops all. No-folder sessions and the sidebar have none. Messages are `term_*` and never queue behind a turn.

The shell runs under ConPTY through `bun:ffi` (`conpty.ts`, Windows-only, `VISE_TERMINAL_SHELL`). Reading blocks, so it runs on a reader thread (`pty-reader-worker.ts`); spawn, write, resize and close run on the main thread (`pty.ts`, which polls for exit because the output pipe stays open until the console closes). Every shell joins one kill-on-close job object so a crash leaves none behind. The child gets `STARTF_USESTDHANDLES` with invalid handles, otherwise a Vise with redirected output would hand that to the shell.

## Steering and queueing

A message sent while a turn runs is **steering** or **queued** (web only; the terminal has no mid-turn input). Steering is added as the user's words before the model's next round (`NoticeQueue`, drained by the round hook, never between a tool call and its result); words the turn ended without reading run as turns of their own. A queued line (`qid`) waits for everything before it, including goal continues, is listed by the server (`queue` message) and removable until it starts. `/steer` and `/queue` act at once. The admission state is currently spread over `conn/line.ts`, `conn/queue-commands.ts` and `server.ts` (see Future work).

## MCP servers

`packages/backend/src/mcp/` is an edge-only client on the official SDK: a stdio program (`command`, `args`, `env`) or an http(s) `url` with static `headers` (Streamable HTTP, then SSE; no OAuth). Their tools become ordinary deferred tools `mcp__<server>__<tool>` in category `mcp_<server>`, so tool search, `/tool`, whitelists, subagents and audit need no special case.

- **Modules.** `mcp-config` reads and validates `mcpServers` from `~/.vise/mcp.json` and `.viserc.json` (project replaces global by name; bad entries are skipped and reported). `McpConnection` wraps one server. `mcp-tools` maps tools and results (text, pictures to the image outbox, `isError` to `error:`). `McpHub` owns a root's connections, routes calls, and offers `reload()` (reconnect only changed entries), `restart(name)`, `close()`. `mcp-store` edits the config files atomically.
- **Fixed tool list.** The hub starts before `createEdgeSession` and a session keeps the list it was built with (it is part of the system prompt and KV cache). Changes reach a conversation when it is rebuilt: the settings tab reloads the page after a save (never mid-turn); the terminal needs a restart. Calls never throw: a lost server returns an `error:` string.
- **Lifecycle.** One hub per root in `RootRegistry`, shared by all pages and closed with the last. A page's connection is built after its hub is ready: `createGate` (`conn/gate.ts`) holds the socket's messages meanwhile and releases the folder exactly once if the page leaves or the start fails; `finishOpening` (`conn/open.ts`) sends the first messages. Closing is safe at any point, including mid-handshake, and hub operations run one at a time.
- **Trust.** A configured server runs a program from the project's files; its descriptions and results are untrusted data. Env values and headers are plain text, so keep credentials in the global file.
- **Future work:** refreshing the tool list of an open conversation; OAuth for remote servers.

## Goal trace

Why a session stopped although a goal was set must be answerable afterwards, so the goal machinery writes every decision to a trace saved with the conversation (`docs/goal-trace.md`). The core stays pure: `goal.ts` functions take an optional `TraceSink` and report each hidden model call (question, raw reply or failure, each retry) and the derived goal; `GoalTracker` adds turn start, verdicts, progress checks, continue notes (themselves kept out of the saved conversation) and exactly one `exit` entry per turn naming why the loop ended, including quiet exits (checking off, no goal, failed turn, interrupt, exception). `Session` owns the `GoalLog` and saves it through `SessionSource.save` after every turn, before each automatic continue and when a turn throws. Storage is the `goal_trace` table, separate from `messages`: loading returns the conversation untouched, search and history paging never see it, deleting the session removes it. Resume restores it only so later saves keep it.

## Audit log

An append-only record of everything the agent did, in the global `~/.vise/audit.db` (each conversation tagged with its root). `VISE_AUDIT=0` turns it off; `VISE_AUDIT_RETENTION_DAYS` deletes older conversations once per run.

- **Capture** is a write-only port: the core defines the `AuditEvent` union and `AuditSink` (`packages/core/src/audit.ts`; `record` never throws or waits on I/O). Each fact has one emitter: model calls `LlmClient.chat`; tool calls `createToolRunner` (`tools/agent/audit-call.ts`, with the whole result before any spill); hook runs `SessionHooks.run`; compactions `runCompaction`; goal events `GoalTracker`; subagent conversations `TurnCallbacks.onSubagentDone`; and messages, turns, commands and saved-id links `SessionAudit` (`repl/turn/session-audit.ts`), which picks messages up by position because the engine appends in place.
- **Storage:** `SqliteAuditSink` (`db/audit/audit-store.ts`) stamps time on `record`, queues, and writes in one transaction after 250 ms or at the end of a turn or conversation. Text fields are cut at 200,000 characters; a failed write drops that batch (counted in `dropped`) and warns once. Tables: `audit_sessions`, `audit_turns`, `audit_messages` (with subagent `depth`), `audit_model_calls`, `audit_tool_calls`, `audit_events`, `audit_fts`.
- **Query** is a separate read port (`AuditReader`: `report`, `search`; `SqliteAuditReader` in `db/audit/audit-query.ts`) whose data `output/audit-format.ts` renders for `/audit`; `--audit-export <id>` prints a conversation as JSON.
- **Retention:** `pruneAuditLog` runs once per run before recording starts, removes each conversation whose last sign of life is older than the setting from every table in one transaction, and never takes one in use. The file is not vacuumed.
- Arguments and results are stored verbatim; there is no redaction yet.

## Potential problems

- **Stringly-typed errors.** A bare-string `throw` or `console.error` in core code should become a structured `Result`; keep display formatting in `output/format.ts`.
- **Pure core vs. network I/O.** The core's basic operation is an HTTP round-trip: the core owns the `Client` _type_, the edge the _implementation_. Never put `fetch` in the core or HTTP logic in `driver/`.
- **Unbounded context.** Compaction keeps `messages` inside the window (see above); tool output is bounded by the spill rule and `read_file` paging.
- **Unbounded subagent recursion.** See Subagents; a depth cap or cost-aware guard is future work.
- **Snapshot durability.** Saved sessions are user data. If several processes ever write the same project store, define an explicit consistency policy rather than relying on process-local serialisation.
- **Auto-save naming.** An internal command such as `/workflow` is not the conversation's first user message and must not claim its auto-save name before a user message exists.
- **Blocking tools.** `ToolRunner.run` is async, but a long child process can still stall a turn; bounded execution time and cancellation (Stop) are driver/engine concerns (see `AGENTS.md`, "Stop").
- **Model switching.** Context limits and usage vary per model; query them per model, never cache a limit across `/model`.
- **TTY assumptions.** The terminal driver hard-codes `terminal: false` readline and a TTY; keep TTY and non-TTY paths separate so each is testable.

## Future work

- **One labelled model-call channel (partly done).** Done: the client owns one progress sink and every call is labelled through `Client.as(purpose)`. Still to do: replace the nine positional parameters of `Client.chat` (one, the per-call progress callback, is passed by nobody) with a `ChatRequest` object `{ messages, tools?, schema?, act?, signal?, purpose }`, and have non-streaming `act` calls report start and end with the measured prompt size to a per-session observer so a new call site cannot be invisible.
- **One turn-admission state machine per conversation.** Which line runs, which are held and which steers are pending should be one pure module (`repl/turn-queue.ts`) with explicit states (`idle`, `running`, `draining`) and transitions (submit, hold, unhold, steer, finish), driven by both the web connection and the terminal instead of booleans and arrays mutated from three files. A steer is accepted or refused atomically with the transition that ends the turn, so none lands after the last drain. The terminal then gets `/steer` and `/queue`.
- **Pictures** (done: content-hashed `Picture`s resolved from the shared `ImageStore` when a request is built). To do: a per-root store behind a port, sweeping unreferenced files on session delete, letting compaction drop bytes but keep the reference, an opt-out for sensitive screenshots, and per-call picture collection instead of a shared outbox.
- **Vision tools absent, not disabled.** While the model cannot see images, `view_image` and `browser_screenshot` should not be in the prompt at all; rebuild that section on model change, when the cache is invalid anyway.
- **Tool display metadata on the tool** (done for label and icon). To do: the arguments worth showing and the sensitive ones (`SHOWN`/`SENSITIVE` in `output/tool-line.ts` are still name-keyed), and readable names in error messages.
- **Structured list payloads** (done for the header and menus via the `lists` message). To do: hooks, workflow and note lists still use their own messages; a closed vocabulary for category names validated at registration.
- **Drivers and CLI.** A pipe/script driver beside the terminal one (makes the tool scriptable and CI-able) and a `cli.ts` with subcommands, shrinking `index.ts` to wiring; `apps/cli` is the placeholder.
- **Structured tool errors.** A `ViseError` variant (e.g. `kind: "tool"`) so failure is not recognised by the `error:` prefix in `engine.ts`, `workflow.ts`, `audit-call.ts`, `tool-line.ts` and the MCP commands.
- **Model configuration.** Parameters (temperature, top_p), aliases, and persisting the default model.
- **Browser reading.** `browser_read` lists only in-viewport elements (capped at 200, a modal first) while text covers the page. To do: a `browser_find` that scrolls until text appears or reports the nearest ref; `SNAPSHOT_SCRIPT` as a typed function with unit tests of the cap and in-view rules; iframes and shadow roots; sticky headers covering click targets; the cost of the scrollable-panel scan.
- **Page actions as data** (done for `select` and `scroll` via `PageAction`/`runPageAction`). To do: move the other widgets (combobox, checkbox/radio, date and contenteditable setters, the first step of `uploadFiles`) onto it; stamp refs with a page generation so a stale ref fails with "page changed, read again"; page or filter the outline instead of capping silently; report repeated identical failures so the loop can stop and ask.
- **Simplification follow-ups.** The stores (`profiles`, `notes`, `workflows`) throw in some paths and return `Result` in others (`tryIo` in `workflows.ts` is the shape to adopt); `readFile` paging reimplements `TempStore.read`; `ChromiumBackend` and `FirefoxBackend` are copy-paste siblings (dialogs, tab registry, key tables, the `inTab` race) wanting a shared base; the page's settings tabs refresh two ways and the tools/git/model dropdowns are built three ways (a `createXPanel(group, send)` factory each); the terminal's Ctrl+C path is unconfirmed.
- **Semantic search.** The index holds every vector in memory (fine for thousands of chunks, not tens of thousands); no per-file "similar passages" view; no hybrid ranking with session full-text search; indexing competes with generation on the local server (small sequential batches, no throttle).
- **Tests and lint.** Core tests first (pure, stub `Client`, never real I/O), then driver tests. Keep lint limits and core import restrictions aligned with the invariants; `test/layout.test.ts` currently skips every directory named `packages`.

## Performance

Real optimisation should be profiler-driven; these are the known concerns.

- **The web chat log.** Appending a line, streaming a reply and scrolling must cost the same at 100 lines and 10,000. Measure with `?bench=<lines>` (`packages/frontend/src/log/bench.ts`, development only). Done: follow the bottom only while reading there, one render per frame with the finished part of a long reply rendered once, lazy pictures, no live region. The conversation is also kept as data (`transcript/chat-lines.ts`), so next: mount only the newest lines (older rebuilt from data, a spacer standing for them), then page older history from the server by `seq` instead of the 400-line cap. Do not rely on `content-visibility` with one guessed height per line: the scrollbar jumps.
- **Interactive latency and startup.** Keep work out of the `line` handler that can be deferred, and keep the entry point's import graph small.
