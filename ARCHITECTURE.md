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
    llm.ts          # LLM transport: implements the core's `Client` type;
                    # wraps fetch, owns URL/key/model config; the sole module
                    # in the tree that performs network I/O
  core/
    engine.ts       # line -> parse -> dispatch to client -> Result pipeline
    errors.ts       # structured error types and constructors
  output/
    format.ts       # Result -> text for terminal or plain output
  repl/
    session.ts      # orchestrates: lines in, results out; owns conversation
                    # state (the growing messages array)
```

Dependency direction (arrows point from dependent to dependency):

```
index.ts ──> cli ──> driver/* ──> session ──> engine
                                       │        │
                                       │        └──> client/llm  (transport)
                                       │
                                       └────────> output/format
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
- **One file doing every job.** `index.ts` is currently entry, driver,
  session, core, and tool dispatch fused (the transport is already
  extracted). It is already past the ~50-line threshold, so the
  driver/session/engine split is overdue, not optional.
- **Pure core vs. network I/O.** The core's fundamental operation is an HTTP
  round-trip, which is I/O. The resolution is the `Client` interface: the
  core owns the _type_, the edge provides the _implementation_. Do not
  put `fetch` in `core/engine.ts`; do not put HTTP logic in `driver/`. If a
  future driver (e.g. a mock client for tests) needs to swap the transport,
  that is the mechanism — not a new module at the core level.
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
- **Implicit global state.** Session state (conversation state, interrupt
  handling) must live in the session object, not in module-level `let`
  bindings, or the core becomes untestable and un-reentrant.

## Future Work

- **Engine.** Extract the line-handling logic (command dispatch, message
  assembly, result handling) from `index.ts` into `core/engine.ts`. The
  engine receives a `Client` and a `Session`, and returns a `Result` per
  line. This makes the pure-core invariant real and enables unit tests with
  a stub client.
- **Session.** Move the conversation state (the `messages` array) and the
  `/exit` command into `repl/session.ts`. The session owns state; the engine
  is stateless.
- **Drivers.** Add the pipe/script driver alongside the terminal driver so the
  same session can be driven non-interactively; this is what makes the tool
  scriptable and CI-able.
- **CLI surface.** `cli.ts` with subcommands and flags; `index.ts` shrinks to
  pure wiring.
- **Tool system.** Tool definitions (`Tool[]`) as core data; `ToolRunner`
  interface in `core/engine.ts` (edge provides implementations, engine
  dispatches by name). Structured tool-execution errors as a `ViseError`
  variant (e.g. `kind: "tool"`), not string-swallowed into the message.
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
