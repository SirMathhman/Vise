# Architecture

This is the canonical design document for Vise. It describes the architecture the project is working toward, not the current code. Keep it ahead of the implementation: when the code catches up, advance this document. It is not a changelog; completed work lives in the git log.

Vise is a Bun + TypeScript command-line application. The target shape is a small, pure core that interprets lines of input, with a thin terminal frontend that owns all I/O.

## Definitions

- **Core**: the pure logic that turns an input line into a result (an echo, and later commands). Core code takes data in and returns data out. It never reads stdin, writes stdout, reads the environment, or touches the clock or filesystem without being passed the capability.
- **Frontend**: code that connects the core to a medium. The terminal frontend is the only one today. It owns readline, prompts, and stream handling.
- **Composition root**: the single entry point that wires a frontend to the core and reads the process environment. It is the only place that touches `process`.
- **Session**: one run of the REPL, from start until `exit`, `quit`, or end of input.
- **Exit word**: a line whose trimmed text is `exit` or `quit`. After an exit word, the session accepts no further lines, even if they arrived in the same chunk of input.
- **Line**: one unit of input without its terminator. Lines are processed in order and each is handled at most once.

Invariants:

1. Once a session has ended, no line after the exit word produces output or side effects.
2. The core never performs I/O. A frontend is the only code that reads or writes streams.
3. Every line the frontend accepts produces exactly one response, or none when the session has ended.
4. Behaviour depends only on the input stream and the arguments passed in, so the same input always gives the same output.

## Structure

Target layout:

```
index.ts            composition root: wires process.stdin/stdout and OPENROUTER_API_KEY to the REPL and the model (entry point, keeps `bun run index.ts`)
src/openrouter.ts   model adapter: streams a chat completion from OpenRouter over HTTPS (performs network I/O, passed to the REPL as a function)
src/core/           pure command interpretation (no node: imports except types)
src/repl/           terminal frontend: readline, prompt, session lifecycle
tests/              tests that exercise the public functions of core and repl
```

Dependency direction is one way only:

```
index.ts  ->  src/repl  ->  src/core
```

`src/core` imports nothing from `src/repl` or `index.ts`. `src/repl` may import `src/core`, never the reverse. Tests may import any module. There are no circular imports.

Each source file has one responsibility. Entry points never contain logic; they only call exported functions. Test files live next to what they test or in `tests/`, not inside the entry point.

Size and style limits, to be enforced by the linter once one is added:

- at most 100 lines per function,
- at most 500 code lines per file,
- at most 10 files per directory.

Recursion is avoided in core. When a function would need to call a function that calls it back, pass the callback as a parameter instead of importing across files.

## Potential Problems

- **Stream-level behaviour is easy to get wrong.** Readline delivers every line in a chunk synchronously, so calling `close()` from inside a `line` handler does not stop the remaining lines of that chunk. Tests must cover lines arriving together in one chunk, not only one chunk per line.
- **Unhandled stream errors.** If the input stream emits an error, the session promise never settles and the process waits. The frontend must listen for `error` and settle with a failure.
- **No write-error handling.** A closed or broken output stream (for example, a pipe closed by the reader) is not reported.
- **Entry point mixes concerns while small.** `index.ts` currently holds both the reusable REPL and the process wiring. Importing it from a test runs the module-level code path only when `import.meta.main` is false, which is easy to break if the guard changes.
- **No linter or formatter configured.** Style and size rules above are not enforced, so they will drift.
- **Unpinned development dependency.** `@types/bun` is set to `latest`, so type checks can change without a code change.
- **`typescript` is only a peer dependency.** A fresh install does not provide the compiler the project's checks need unless the user has it installed.

## Security Concerns

Trust boundaries: everything read from stdin is untrusted text, and every line is sent to OpenRouter, a third party. The model's reply is also untrusted text. Vise has no file writes and no process spawning. The API key comes from `.env` and must never be echoed or logged. Only the echo path outputs were reviewed before the model was added; the terminal-injection and length controls below still apply to model replies.

- **Terminal escape injection.** Input is echoed back verbatim. A line containing ANSI or other control sequences can change the terminal's state (title, colours, cursor, clipboard on some terminals). The ideal control is to strip or escape control characters other than tab before echoing. This control is **missing**.
- **Unbounded input.** A very long line or an unending stream is read into memory without a limit. The ideal control is a maximum line length, with a defined response when it is exceeded. This control is **missing**.
- **Future command execution.** When commands arrive that act on the user's machine or other services, every command must be explicit, must not be reachable by a free-form line that only echoes, and must be reviewed on its own. No such commands exist yet.
- **Secrets.** Vise must never log input lines to a file by default, since users may paste secrets. No logging exists yet.

## Future Work

- Move command interpretation into `src/core` as pure functions over `(state, line) -> (state, output)`, so the REPL is a thin driver.
- Add a linter that enforces the size and naming limits, and a formatter. Both are part of the first change that adds more than one command.
- Make the session a function of its inputs: the readline interface is created by the frontend and passed where needed, so tests can drive a session without touching real streams.
- Introduce a structured result type for command outcomes (success, usage error, unknown command) instead of ad-hoc strings, with errors that say what failed, where, why, and what the user can do.
- Add a maximum line length and control-character handling before echo.
- Pin dev dependencies to specific versions, and declare `typescript` as a dev dependency so checks run on a clean install.

## Performance

These are the obvious concerns only. Measure with a profiler before optimizing.

- Each echoed line is written with a separate `write` call. Fine at interactive speed; large piped inputs would benefit from buffering output per chunk.
- Long lines are held whole in memory before they are echoed. This is bounded only by the line-length limit once it exists.
- Startup cost of `bun run` is dominated by the runtime, not by this code.
