# Vise — Architecture

This document describes the ideal architecture that `vise` is working toward.
It deliberately points well ahead of the current code. It is not a changelog:
completed work is visible in the git log; this document only describes the
target architecture and the work that remains.

## Definitions

- **Vise** — the tool itself: an interactive command-line environment for
  working with code, run on the Bun runtime. The name evokes a vice: something
  that grips and holds its subject in place.
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
  core/
    engine.ts       # line -> parse -> evaluate -> Result pipeline
    errors.ts       # structured error types and constructors
  output/
    format.ts       # Result -> text for terminal or plain output
  repl/
    session.ts      # orchestrates: lines in, results out; owns session state
```

Dependency direction (arrows point from dependent to dependency):

```
index.ts ──> cli ──> driver/* ──> session ──> engine
                                       │
                                       └────────> output/format
errors.ts is imported by engine, session, and output — and by nothing else
```

Rules:

- `index.ts` stays a thin entry point: wire argv to a driver and run. It
  should remain under 50 lines and never contain a `for` loop over lines.
- `core/` has zero `node:` imports and is unit-testable with plain assertions.
- `driver/terminal.ts` and `driver/pipe.ts` are siblings sharing the same
  session API; choosing between them is driven by
  `process.stdin.isTTY` / argv, not by special-casing inside the loop.
- Every file stays under 500 code lines and every function under 100 lines;
  when a module approaches that, split it along a natural seam.

This is the shape the current single-file REPL is growing into: today
`index.ts` plays the roles of entry point, driver, session, and core all at
once. As functionality lands, those roles separate into the modules above —
each module exists as soon as its role earns it, not before.

## Potential Problems

- **Forced process exit.** Any `process.exit()` anywhere will truncate
  buffered `stdout` when the output is a pipe and can mask real exit codes.
  Audit new code for it; termination must flow through event-loop draining.
- **Stringly-typed errors.** If `throw` or `console.error` with a bare string
  appears in core code, convert it to a structured `Result`/error type before
  the pattern spreads. The current echo path has no error surface; the moment
  evaluation is added, this is where errors will first appear.
- **One file doing every job.** `index.ts` is currently all four roles (entry,
  driver, session, core). If it grows past ~50 lines, the driver/session split
  is overdue, not optional.
- **Unbounded line input.** A piped file is unbounded. The core must process
  lines streaming, one at a time, and never buffer the whole input in memory.
- **TTY-only assumptions.** Today the readline interface hard-codes
  `terminal: false` and assumes a TTY. The driver split exists precisely so
  TTY and non-TTY paths are tested independently; do not re-couple them.
- **Implicit global state.** Session state (line history, interrupt handling)
  must live in the session object, not in module-level `let` bindings, or the
  core becomes untestable and un-reentrant.

## Future Work

- **Structured evaluation.** Replace the echo with a real `parse → evaluate`
  pipeline in `core/engine.ts` returning `Result` values.
- **Drivers.** Add the pipe/script driver alongside the terminal driver so the
  same session can be driven non-interactively; this is what makes the tool
  scriptable and CI-able.
- **CLI surface.** `cli.ts` with subcommands and flags; `index.ts` shrinks to
  pure wiring.
- **Error model.** `core/errors.ts` with a small discriminated error union
  (e.g. parse failure, runtime failure, I/O failure), each variant answering
  the four questions above.
- **Session state.** Line history, interrupt (Ctrl+C) handling, and clean
  termination state owned by `session.ts`, exercisable without a real TTY.
- **Tests.** Core tests first (pure, fast, no I/O), then driver tests against
  piped input. A core test must never open a real stdin/stdout.
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
