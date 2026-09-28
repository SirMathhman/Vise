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
index.ts            # entry point: parses argv, constructs driver, runs session
src/
  cli.ts            # argument parsing, subcommands, flag definitions
  driver/
    terminal.ts     # interactive TTY driver: prompt, echo, readline wiring
    pipe.ts         # piped/script driver: read input to EOF, emit results
  client/
    llm.ts          # LLM transport: implements the core's `Client` type,
                    # `ContextSource`, and `ModelController`; wraps fetch,
                    # owns URL/key/model config; the sole module in the tree
                    # that performs network I/O
  core/
    engine.ts       # line -> parse -> dispatch to client -> Result pipeline
    errors.ts       # structured error types and constructors
  output/
    format.ts       # Result -> text for terminal or plain output
  repl/
    session.ts      # orchestrates: lines in, results out; owns conversation
                    # state (the growing messages array)
  tools.ts          # edge-provided tool definitions (`Tool[]`) and `ToolRunner`
                    # implementation: all tool I/O (file ops, shell commands)
```

Dependency direction (arrows point from dependent to dependency):

```
index.ts ──> cli ──> driver/* ──> session ──> engine
                                       │        │
                                       │        └──> client/llm  (transport)
                                       │
                                       └────────> output/format
tools.ts ──> engine                  # edge: tool definitions + ToolRunner implementation
errors.ts is imported by engine, session, output, and client — and by nothing else
```

Rules:

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
  in `index.ts`, backed by `profiles/*.md` files). Same pattern as
  `ModelController`: core owns the interface, edge does the I/O.
- Every file stays under 500 code lines and every function under 100 lines;
  when a module approaches that, split it along a natural seam.

This is the shape the current code is growing into: today `index.ts` plays
the roles of entry point, driver, session, and core all at once, while the
transport already lives in `client/llm.ts`. As functionality lands, those
roles separate into the modules above — each module exists as soon as its
role earns it, not before.

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
  and driver layer (~38 lines); the transport, tool dispatch, engine,
  and session are already extracted into their own modules. What
  remains is the driver split (TTY vs. pipe) and the `cli.ts` surface.
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
- **Unbounded line input.** A piped file is unbounded. The core must process
  lines streaming, one at a time, and never buffer the whole input in memory.
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
  bindings, or the core becomes untestable and un-reentrant.
- **Dynamic model switching and context awareness.** Model switching
  via `/model` changes the active model on the client. Because context
  limits and token usages vary per model, the session must query `contextMax`
  and context usage dynamically with each model rather than caching a static
  limit across model transitions.

## Future Work

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
- **Session state.** Conversation state (the growing `messages` array),
  interrupt (Ctrl+C) handling, and clean termination state owned by
  `session.ts`, exercisable without a real TTY.
- **Tests.** Core tests first (pure, fast, no I/O — use a stub `Client`), then
  driver tests against piped input. A core test must never open a real
  stdin/stdout or make a real HTTP call.
- **Lint enforcement.** Add the linter rules that enforce the modularity
  limits (function size, file size, no-`node:`-imports-in-core via an import
  restriction rule).

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
