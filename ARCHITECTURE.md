# Vise — Architecture

The ideal architecture this project is working toward. This document points ahead of
the code; it is not a changelog. Progress lives in the git log.

## Definitions

- **Turn** — one user message plus the model's reply to it. A turn is the unit of
  state that accumulates in a conversation.
- **Conversation** — the ordered, in-memory sequence of turns (user + assistant
  messages) sent to the model on every request. It is the REPL's source of truth
  for context.
- **LLM client** — the single module that knows the wire protocol
  (OpenAI-compatible `POST /v1/chat/completions` against llama.cpp). Everything
  else talks to the model through this module and nothing else.
- **Transport** — how stdin is read and how output is rendered (prompts,
  assistant replies, errors). Swappable, and the only module allowed to touch
  `process.stdin`/`process.stdout`.
- **Config** — the typed, env-derived settings object (base URL, model, API
  key, pre-session command, pre-turn command, post-turn command). Constructed
  once at startup. Read-only everywhere except the model selector, which owns
  the one mutable field (`model`) and is the only writer of config back to
  disk.
- **Command** — a line beginning with `/` that the REPL handles locally and
  never sends to the model. A command is a pure function of its arguments plus
  the session state it is handed; it returns a result the renderer prints.
- **Model catalog** — the set of models the server reports at `GET /v1/models`,
  each with a load status. The catalog is the authority for what a model name
  may be; the selector never accepts a name the catalog does not contain.
- **Model selector** — the single owner of the active model name. It reads the
  catalog, validates a requested name against it, updates the in-memory value,
  and persists the choice. Nothing else may mutate the active model.
- **Tool** — a function the model can call (e.g. `read_file`, `edit_file`,
  `run_powershell`) to act on the filesystem or execute external processes.
  During a turn, tools are the only modules permitted to read or write files
  or spawn subprocesses (hook commands are the only exception, see
  invariant 5); they never call `fetch` and never touch the conversation
  directly — they return a string result that the loop appends as a
  `role: "tool"` message.
- **Tracked process** — a background subprocess the model started without
  awaiting to completion, identified by a process ID. Its accumulated
  stdout/stderr, exit code, and liveness are kept for the rest of the
  session so `wait_for_process` and `kill_process` can act on it later.
- **Profile** — a named set of custom system instructions (a persona).
  Profiles come from two sources: a built-in "Agent" default (whose
  instruction is the CWD message) and file-based profiles from `.agents/*.md`
  in the working directory. Switching profiles appends a new system message
  to the conversation; existing history is never altered.
- **Hook command** — a shell command that runs at a fixed point around turns.
  Hooks come from two sources: env-var config (`PRE_SESSION_CMD`,
  `PRE_TURN_CMD`, `POST_TURN_CMD`) and directory-based hooks
  (`.hooks/<type>/*.cmd` files, where `<type>` is `pre-session`, `pre-turn`,
  or `post-turn`; each file's trimmed content is a command, files run in
  alphabetical order). Env-var hooks run first, followed by directory hooks;
  all hooks run regardless of prior failures (continue-on-error semantics).
  The pre hooks always print their combined stdout+stderr and append it to
  the conversation as a system message, on success or failure. The post hook
  is silent on success (neither printed nor appended, so a passing check never
  pollutes context) and, on failure (non-zero exit), prints the output as a
  warning and appends it as a system message so the model sees it on the next
  turn. Unlike tools, hooks are driven by config rather than by the model, and
  they run at fixed points rather than on demand.

**Invariants:**

1. The LLM client must never import from the transport, and the transport must
   never import from the LLM client. All cross-cutting state (conversation,
   config) flows _down_ from the entry point, never sideways between those two
   modules.
2. The LLM client is the only module that calls `fetch`. The model catalog is
   fetched through the client, not beside it.
3. Commands never reach the model. A command's rendered output is printed by
   the transport, never appended to the conversation. A command may request
   a state change via its result (e.g. `setModel` changes the active model,
   `setProfile` causes the loop to append a new system message carrying the
   profile's instruction); the loop applies these side effects. A profile
   switch appends a new system message but never alters existing history.
4. The active model is read at request time, not captured at startup, so a
   switch takes effect on the next turn without rebuilding the client.
5. Tools are the only modules that read or write the filesystem or execute
   external processes during a turn. The hook system is the only exception:
   `src/repl/hooks.ts` reads the `.hooks/<type>/` directory at startup to
   discover directory-based hooks (read-only filesystem access, no
   subprocesses), and `src/repl/presession.ts` (to be renamed `externalcmd.ts`,
   see Future Work) spawns exactly one subprocess per hook invocation. No
   other module outside the tools may read the filesystem or spawn a
   subprocess. Neither the tools nor the hook modules call `fetch` or touch
   the conversation directly; tools return a string result that the loop
   appends as a `role: "tool"` message, and the loop appends hook output as
   a `role: "system"` message (pre hooks always; the post hook only when it
   exits non-zero, per the hook command definition).
6. Session-long state (the set of tracked processes) is created at the entry
   point and passed to tools as a parameter — the same pattern as commands
   receiving the client. `tools.ts` holds no module-level mutable state.

## Structure

Module layout and dependency direction (each directory/file below is a real,
split-on-demand module — the single-file `index.ts` is the collapsed form of
this graph):

```
index.ts              entry point: build Config, wire Transport + Client + Repl, run
src/config.ts         read env -> typed Config. No I/O beyond reading env, no fetch.
src/config/persist.ts rewrite a single key in .env.local. The only module that
                        writes config to disk; takes a path + key + value.
src/llm/types.ts      Message, ChatMessage, ChatCompletionRequest/Response shapes.
src/llm/client.ts     LLM client: takes Config + messages, returns a structured
                        result. The ONLY place fetch() is called.
src/llm/models.ts     model catalog: list models via the client, validate a name
                        against the catalog. No fetch of its own.
src/profiles.ts       profile registry: list and look up profiles. Profiles
                        come from the built-in Agent default plus .agents/*.md
                        files in the CWD. Pure functions over the filesystem.
                        No mutable state, no fetch, no stdin/stdout.
src/repl/input.ts     stdin buffering (line queue + nextLine). No fetch, no state.
src/repl/render.ts    prompt/answer/error rendering. Pure formatting.
src/repl/commands.ts  the command registry: parse a `/` line, dispatch to a
                        handler, return a result. No fetch, no stdin/stdout.
src/repl/hooks.ts    hook discovery: reads `.hooks/<type>/` directories
                        (read-only filesystem access, the only non-tool FS
                        read, invariant 5), returns `HookCommand[]` with
                        `{ name, command }` in alphabetical order. No
                        subprocesses, no printing, no fetch.
src/repl/presession.ts runs the configured hook commands: `PRE_SESSION_CMD`
                        once before the first turn, `PRE_TURN_CMD` once before
                        every user turn, and `POST_TURN_CMD` once after the
                        model's final answer. Spawns exactly one subprocess per
                        invocation (the only non-tool spawn, invariant 5),
                        returns the combined stdout+stderr and exit code; no
                        printing of its own — the loop renders the result and
                        appends it to the conversation as a system message
                        (pre hooks always; the post hook only when it exits
                        non-zero).
src/repl/loop.ts      the turn loop: glue between input, conversation, client,
                        commands, render, and presession.
src/tools.ts          tool registry: schema array + dispatch table. Imports
                        handler functions from the tool submodules below and
                        composes them into the `Record<string, handler>` table.
                        No I/O of its own — all filesystem and process work
                        lives in the submodules. Stateless: the ProcessTracker
                        (background subprocess map + ID counter) is passed in
                        as a parameter per invariant 6. No fetch, no
                        stdin/stdout.
src/tools/process.ts  background process tracking: TrackedProcess, spawn,
                        track, and format helpers; the ProcessTracker class;
                        and the run_powershell / wait_for_process /
                        kill_process handlers. The only tool submodule that
                        spawns subprocesses.
src/tools/fs.ts       file-system handlers: read_file, edit_file, create_file,
                        create_directory, list_directory. The only tool
                        submodule that writes files.
src/tools/search.ts   content-search handlers: find_files, search_content.
                        Owns the shared walkFiles generator, displayPath, and
                        escapeRegex helpers. Read-only filesystem access.
```

Dependency direction: `index -> src/repl/loop -> (src/repl/input, src/repl/render,
src/repl/commands, src/repl/presession, src/llm/client, src/tools, src/profiles)
-> src/llm/models -> src/llm/types, src/config`. `src/llm/*` and `src/repl/*`
do not import each other.
`src/tools/*` do not import each other; `src/tools.ts` is the only importer of
the tool submodules. `src/config.ts`, `src/config/persist.ts`, `src/llm/types.ts`,
`src/profiles.ts`, and the `src/tools/*` submodules are leaves.

Commands are the seam that keeps the loop small: `commands.ts` returns a result
value (text to render, or a request to mutate session state) and never prints or
reads input itself. Adding a command must not require editing `loop.ts`; the
registry is the extension point. A command that needs the model (e.g. a future
`/summarize`) receives the client as a parameter rather than importing it, so
`commands.ts` stays free of `fetch` and of the transport.

Enforcement: the `bun lint` script (Biome) enforces what it can; the rest
(function/file/directory line limits — 100/500/10 — is caught by this review and
by the madge-style dependency check below).

Dependency check: `madge --extensions ts src/ index.ts` must show no cycles.
Run it in CI or as part of `bun lint` before it matters.

## Potential Problems

- **Unbounded conversation.** `messages` grows linearly with turns; every request
  re-sends the whole history, so a long session is O(n^2) tokens total and will
  eventually exceed the model's context window (the server returns an error
  rather than truncating). Watch for: 400/413-style errors from llama.cpp on
  long sessions. The fix is a bounded window (keep last N messages or tokens)
  owned by `loop.ts`, not by `client.ts`. Profile switches also append system
  messages to the conversation, so repeatedly switching profiles adds
  redundant context that the bounded window must account for. The pre-session
  hook's output enters the conversation the same way, so it must be bounded
  too (below). The pre-turn hook compounds this: it appends a system message
  every turn (up to the 16 KB hook budget each), so even a chatty hook that
  fits in context once will exhaust the window after enough turns; the
  bounded window is the only fix. The post hook compounds it too, but only
  while it is failing: a failing post hook appends its output every turn, so
  a hook that stays broken adds one system message per turn.
- **Hook command output is unchecked and its latency is unbounded.** Unlike
  tool results (16 KB budget per tracked-process stream, 500-line read cap),
  the pre-session and pre-turn hooks' combined stdout+stderr enter the
  conversation with no budget beyond the shared 16 KB hook cap; their exit
  codes are only printed to stderr, so a failing hook's output still reaches
  the model as context (the post hook deliberately inverts this: it appends
  only on failure, but its appended message carries the raw output with no
  exit-code report, so the model cannot tell the hook failed unless the output
  says so); and they have no timeout, so a hung hook blocks startup
  (pre-session), every user turn (pre-turn), or every final answer (post-turn).
  A hook that fails with no stdout/stderr is also silently dropped — the
  runner returns `null` for empty output, discarding the exit code — so a
  failing check can reach neither the user nor the model. Report a non-zero
  exit code distinctly in the appended message, and give the spawn the same
  timeout/structured-error treatment the client's `fetch` should have.
- **Duplicate CWD system message.** The loop seeds the conversation with a
  hardcoded CWD string, and `BUILTIN_AGENT.instruction` is the same string.
  If the user explicitly runs `/profile Agent`, a second identical CWD
  message is appended. The loop should seed with `BUILTIN_AGENT.instruction`
  so `profiles.ts` is the single source of truth for the default
  instruction.
- **No retry or timeout on `fetch`.** A hung llama.cpp server blocks the REPL
  forever; a transient ECONNREFUSED is reported as a generic error. The client
  should have a `signal`/timeout and a distinguishable "server unreachable"
  error.
- **Hard `process.exit(0)` at shutdown.** Any finally-block cleanup or future
  teardown (e.g., flushing a session log) is skipped. Prefer letting the event
  loop drain; keep `process.exit` as a last resort for a stuck loop.
- **Errors are opaque strings.** `Error("HTTP 404: ...")` does not say what
  caused it or what to do. The client should return a structured result
  (`Ok | HttpError | NetworkError`) that answers: what, where, why, fix.
- **Config defaults mask misconfiguration.** `LLM_BASE_URL ?? "http://localhost:8080"`
  silently falls back; a missing `.env.local` produces a confusing network
  error rather than "config missing." Prefer a loud startup check.
- **Config is written back to disk by the REPL.** Persisting the model choice
  makes the process a writer of its own configuration, which is a new failure
  mode: a non-atomic `writeFileSync` can truncate `.env.local` on a crash, a
  value containing spaces or `#` is written unquoted, and a read-only or
  missing directory surfaces as a raw filesystem error. Keep the write in
  `config/persist.ts`, make it atomic (write temp + rename), and treat a failed
  persist as a warning, not a failed switch.
- **Command surface can grow into a god module.** `commands.ts` is the natural
  place for every future `/` feature, and each one tends to want the client, the
  conversation, and the renderer. Keep handlers as pure functions of explicit
  parameters; if a handler needs to print, it returns text instead. Watch for
  `commands.ts` importing `loop.ts` (that would be a cycle).
- **Model switch is not validated against the conversation.** Switching models
  mid-session keeps the history, which is the intended behavior, but a model
  with a smaller context window may reject the accumulated history on the next
  turn. The bounded window (above) is the real fix; until then, a switch is a
  plausible trigger for a context-length error.
- **Catalog fetch is a second network path.** `/model` performs a request that
  is not a chat completion. It must go through the client so timeouts, auth
  headers, and structured errors are shared; a bare `fetch` in the command
  handler would duplicate all three.
- **Tool results are opaque strings.** A tool failure is reported as prose the
  model must parse to decide whether to retry. A structured result
  (`Ok | ToolError`) would say what, where, why, fix. `edit_file` only
  replaces the _first_ occurrence of `replacee`; a model editing a repeated
  string will silently miss later occurrences.
- **Background processes outlive the REPL on interrupt.** The EOF path
  reaps tracked processes (`tracker.shutdown()` before `process.exit`),
  but Ctrl-C/SIGINT orphans every running background `powershell`
  subprocess, and finished entries are never pruned from the map, so dead
  process objects can be held for the rest of the session. Reaping must
  cover every exit path (a `process.on("exit")`/`SIGINT` hook in `loop.ts`),
  and the tracker should drop finished entries on access.
- **`list_directory` output is unbounded.** Unlike `read_file` (500-line cap)
  and tool output from tracked processes (16 KB cap), a directory tree has
  no line budget: a `node_modules` at depth ≥ 2 can return thousands of
  lines into the conversation. The walk should filter noise
  (`node_modules`, `.git`) and/or cap the output, the same way the other
  tool results are bounded.

## Future Work

- **Rename `src/repl/presession.ts` to `src/repl/externalcmd.ts`.** The module
  now runs all three hook commands (`PRE_SESSION_CMD` once before the first
  turn, `PRE_TURN_CMD` before every user turn, `POST_TURN_CMD` after the
  model's final answer), so its name no longer reflects its contents. Rename
  it and its exports (`runPreSessionCmd` -> `runShellCommand`,
  `PreSessionResult` -> `ShellResult`) to the generic hook-command runner,
  and collapse the six run -> render -> push blocks in `loop.ts` (three
  call sites × two sources: env-var and directory hooks) into a single local
  helper that takes the command, a label, and per-hook policy — render
  `always` | `onFailure` and append `always` | `onFailure` — since the post
  hook diverges from the pre hooks (silent on success). `render.ts` gets one
  `renderHook(label, output, exitCode, renderOnSuccess: boolean)` instead of
  the four label-specific renderers (`renderPreSession`, `renderPreTurn`,
  `renderPostTurn`, `renderHook`). In the same pass, stop discarding
  the exit code when a hook produces no output (a failing check with empty
  stdout+stderr is currently dropped), and prefix the appended message with
  the label and exit code so the model can tell a hook failed. This is the
  direct fix for `loop.ts`'s `run` function exceeding the 100-line limit
  (currently 174 lines).
- **Per-tool co-located modules.** Each tool is a self-contained `ToolModule`
  export from its submodule: a schema (the `Tool` object describing arguments
  to the model) paired with the handler that executes it. `tools.ts` becomes
  pure composition — it imports all `ToolModule` exports and builds the
  `Tool[]` array and dispatch table from them, holding no inline schema
  definitions. Adding a tool then touches exactly one submodule file. Target
  shape:
  ```ts
  export type ToolModule = {
    schema: Tool;
    handler: (
      args: Record<string, unknown>,
      tracker: ProcessTracker,
    ) => Promise<string>;
  };
  ```
  This keeps `tools.ts` under 50 lines and makes the schema the single source
  of truth for what a handler accepts, living next to the code that consumes
  those arguments.
- **Typed tool arguments.** Each `ToolModule` declares a typed argument
  interface (e.g., `ReadFileArgs { path: string; startLine?: number;
endLine?: number }`) rather than `Record<string, unknown>`. The handler
  signature becomes `(args: ReadFileArgs, tracker: ProcessTracker) =>
Promise<string>`, with a thin validation/coercion step at the registry
  boundary that converts the model's JSON into the typed shape. This catches
  argument-name typos at compile time and removes per-handler runtime
  coercion (`String(args.path ?? "")`).
- **Structured tool results.** Handlers return a `ToolResult` discriminated
  union (`{ ok: true; text: string } | { ok: false; error: string;
retryable: boolean }`) instead of a bare string. The loop renders the error
  case distinctly and can log non-retryable failures without the model
  guessing from prose.
- **Streaming responses.** `stream: true` + SSE parsing in `client.ts` so the
  user sees tokens as they arrive; `render.ts` gains an append mode. The
  conversation still accumulates the full reply before the next turn.
- **Command registry.** A table of `{ name, description, handler }` so `/help`
  is generated rather than hand-written, unknown commands suggest the nearest
  match, and adding a command is a one-line registration. `/reset` (clear the
  conversation) and `/model` are the first entries.
- **Session persistence.** Serialize the conversation to disk so a crash or
  Ctrl-C does not lose context; the transport stays oblivious.
- **Ctrl-C process reaping.** `tracker.shutdown()` runs before
  `process.exit` on the EOF path but not on a Ctrl-C interrupt; add a
  `process.on("exit")` (or `SIGINT`) hook in `loop.ts` that kills any
  remaining tracked processes.
- **Tests.** Unit tests for `input.ts` (line buffering), `client.ts` (against a
  mocked `fetch`), `loop.ts` (conversation accumulation), and each tool
  handler (filesystem fixtures + a stubbed `ProcessTracker`). These are the
  seams that make the module split above safe to execute.

## Performance

Obvious concerns only — profile before optimizing.

- **Perceived latency:** the full reply is awaited before any output; streaming
  (Future Work) is the real fix, not a micro-optimization.
- **Token cost:** re-sending full history every turn doubles the tokens per
  added turn; the bounded window is the fix and is also a correctness issue.
- **Memory:** the line buffer is bounded by input; the conversation is bounded
  only by the model's context window, not by the process. Tracked-process
  output is bounded by `OUTPUT_BUDGET` (16 KB per stream per process, with a
  truncation marker). `read_file` is bounded at 500 lines per call.
  `list_directory` is currently unbounded (see Potential Problems).
- **Command latency:** `/model` with no argument performs a network round-trip
  before printing anything, so it inherits the client's (currently absent)
  timeout. A cached catalog would make listing instant but could go stale; the
  catalog is small, so re-fetching is the right default.
