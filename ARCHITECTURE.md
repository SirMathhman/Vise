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
- **Config** — the typed, env-derived settings object (base URL, model, API key).
  Constructed once at startup. Read-only everywhere except the model selector,
  which owns the one mutable field (`model`) and is the only writer of config
  back to disk.
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
  Tools are the only modules permitted to read or write files or spawn
  subprocesses; they never call `fetch` and never touch the conversation
  directly — they return a string result that the loop appends as a
  `role: "tool"` message.
- **Tracked process** — a background subprocess the model started without
  awaiting to completion, identified by a process ID. Its accumulated
  stdout/stderr, exit code, and liveness are kept for the rest of the
  session so `wait_for_process` and `kill_process` can act on it later.

**Invariants:**

1. The LLM client must never import from the transport, and the transport must
   never import from the LLM client. All cross-cutting state (conversation,
   config) flows _down_ from the entry point, never sideways between those two
   modules.
2. The LLM client is the only module that calls `fetch`. The model catalog is
   fetched through the client, not beside it.
3. Commands never reach the model. A command's output is rendered by the
   transport, never appended to the conversation.
4. The active model is read at request time, not captured at startup, so a
   switch takes effect on the next turn without rebuilding the client.
5. Tools are the only modules that read or write the filesystem or execute
   external processes. They never call `fetch` and never touch the conversation
   directly; they return a string result that the loop appends as a
   `role: "tool"` message.
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
src/repl/input.ts     stdin buffering (line queue + nextLine). No fetch, no state.
src/repl/render.ts    prompt/answer/error rendering. Pure formatting.
src/repl/commands.ts  the command registry: parse a `/` line, dispatch to a
                        handler, return a result. No fetch, no stdin/stdout.
src/repl/loop.ts      the turn loop: glue between input, conversation, client,
                        commands, render.
src/tools.ts          the tool registry and dispatch: schema array + a
                        `Record<string, handler>` table. The only module that
                        reads or writes the filesystem or executes external
                        processes. Stateless: the ProcessTracker (background
                        subprocess map + ID counter) is passed in as a
                        parameter per invariant 6. No fetch, no stdin/stdout.
```

Dependency direction: `index -> src/repl/loop -> (src/repl/input, src/repl/render,
src/repl/commands, src/llm/client) -> src/llm/models -> src/llm/types, src/config`.
`src/llm/*` and `src/repl/*` do not import each other. `src/config.ts`,
`src/config/persist.ts`, and `src/llm/types.ts` are leaves.

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
  owned by `loop.ts`, not by `client.ts`.
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
- **Background processes outlive the REPL.** Tracked processes are never
  reaped on exit: `process.exit(0)` (and Ctrl-C) orphan every running
  background `powershell` subprocess, and a tracked entry is only removed
  when the model explicitly awaits or kills it, so the map can hold dead
  process objects for the rest of the session. The tracker needs a shutdown
  hook the loop calls on exit, and finished entries should be pruned.
  The `ProcessTracker` (in `tools.ts`) is the loop's hook for this: `loop.ts`
  calls `tracker.shutdown()` before `process.exit`, which kills every
  unfinished tracked process and clears the map. The Ctrl-C path still
  skips it; a `process.on("exit")` hook would cover that.

## Future Work

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
  mocked `fetch`), and `loop.ts` (conversation accumulation). These are the
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
  truncation marker).
  output is bounded by neither: stdout/stderr accumulate until the process
  exits (Future Work).
- **Command latency:** `/model` with no argument performs a network round-trip
  before printing anything, so it inherits the client's (currently absent)
  timeout. A cached catalog would make listing instant but could go stale; the
  catalog is small, so re-fetching is the right default.
