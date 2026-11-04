# Architecture

This is the canonical design document for Vise. It describes the architecture the project is working toward, not the current code. Keep it ahead of the implementation: when the code catches up, advance this document. It is not a changelog; completed work lives in the git log.

Vise is a Bun + TypeScript command-line application. The target shape is a small, pure core that interprets lines of input, with a thin terminal frontend that owns all I/O.

## Definitions

- **Core**: the pure logic that turns an input line into a result (line classification and command output, and later the command state). Core code takes data in and returns data out. It never reads stdin, writes stdout, reads the environment, or touches the clock or filesystem without being passed the capability.
- **Frontend**: code that connects the core to a medium. The terminal frontend is the only one today. It owns readline, prompts, and stream handling.
- **Composition root**: the single entry point that wires a frontend to the core and reads the process environment. It is the only place that touches `process`.
- **Session**: one run of the REPL, from start until `/exit` or end of input.
- **Command**: a line whose trimmed text starts with `/`. Commands are interpreted by the core and never sent to the model. The set is `/exit` and `/context` today; the core classifies any other `/` line as `unknown-command`, and the frontend reports it as an error.
- **Exit command**: a line whose trimmed text is `/exit`. The core's line classifier recognises it; after it, the session accepts no further lines, even if they arrived in the same chunk of input. Bare words such as `exit` or `quit` are ordinary lines.
- **Context command**: a line whose trimmed text is `/context`. It reports the prompt tokens the provider counted for the most recent request that reported usage, out of the model's context window. Both numbers come from the provider, not from an estimate. Before any request has reported usage it reports that no request has been sent.
- **Line**: one unit of input without its terminator. Lines are processed in order and each is handled at most once.

Invariants:

1. Once a session has ended, no line after the exit word produces output or side effects.
2. The core never performs I/O. A frontend is the only code that reads or writes streams.
3. Every line the frontend accepts produces exactly one response, or none when the session has ended.
4. Behaviour depends only on the input stream and the arguments passed in, so the same input always gives the same output. The model adapter and the context-window lookup are the exceptions: their replies come from the network, so the adapter must make every reply it returns either complete or an error, never a silently truncated success, and the lookup must do the same.
5. Commands never reach the model. A `/` line is consumed by the core whether or not it is known.

## Structure

Target layout:

```
index.ts            composition root: wires process.stdin/stdout and OPENROUTER_API_KEY to the REPL and the model (entry point, keeps `bun run index.ts`)
src/openrouter.ts   model adapter: streams a chat completion from OpenRouter over HTTPS (performs network I/O, passed to the REPL as a function)
src/core/           pure line classification and command interpretation (no node: imports except types)
src/repl/           terminal frontend: readline, prompt, session lifecycle
src/core/messages.ts  shared data types (ChatMessage, Usage)
src/core/result.ts    Result type (ok / err) for failures that are returned, not thrown
scripts/            build checks run by `bun run lint` (file count per directory)
*.test.ts           beside the module each one tests (no separate tests/ folder)
```

Dependency direction is one way only:

```
index.ts  ->  src/repl  ->  src/core
index.ts  ->  src/openrouter.ts  ->  src/core
```

`src/core` imports nothing from `src/repl`, `src/openrouter.ts`, or `index.ts`. `src/repl` and `src/openrouter.ts` may import `src/core`, never the reverse. Tests may import any module. There are no circular imports.

Each source file has one responsibility. Entry points contain wiring only: they read the environment, construct the functions, and call exported functions. Test files live next to what they test, not inside the entry point.

The composition root supplies the reply function and the context-window lookup explicitly. The frontend has no default model, so a session that forgets to pass one fails instead of silently echoing.

Size and style limits, enforced by `bun run lint` as errors (ESLint for the line, function, and type-literal rules, `scripts/check-files-per-dir.ts` for the file count):

- at most 100 lines per function (`max-lines-per-function`),
- at most 500 code lines per file (`max-lines`),
- at most 10 files per directory,
- no object type literals written inline as `{ ... }` (`no-restricted-syntax` on `TSTypeLiteral`); declare a named interface instead.
- no `throw` statements (`no-restricted-syntax` on `ThrowStatement`); failures are returned as a `Result` from `src/core/result.ts`.

Recursion is avoided in core. When a function would need to call a function that calls it back, pass the callback as a parameter instead of importing across files.

## Potential Problems

- **Stream-level behaviour is easy to get wrong.** Readline delivers every line in a chunk at once, so lines already buffered after `/exit` are still yielded by the loop unless the loop stops at the exit line. A regression test must keep covering lines that arrive together in one chunk, not only one chunk per line.
- **The file-count check ignores untracked files.** `scripts/check-files-per-dir.ts` reads `git ls-files`, so a new file counts only after it is staged. A directory can exceed the limit until someone runs `git add`.
- **The frontend has default model stand-ins.** `runRepl` defaults its reply function to an echo and its context-window lookup to `undefined`, so a caller that omits them gets fake model behaviour without an error. The composition root should pass both explicitly.
- **Unhandled stream errors.** If the input stream emits an error, the session promise never settles and the process waits. The frontend must listen for `error` and settle with a failure.
- **No write-error handling.** A closed or broken output stream (for example, a pipe closed by the reader) is not reported.
- **Partial replies stay on screen.** When a model stream fails (an `{"error": ...}` event, or the connection ending before `data: [DONE]`), `streamChat` yields an `err` result and `runRepl` drops the user line from the history, so no truncated answer is recorded. The text already printed is not marked as incomplete, and nothing tells the user it was discarded.
- **Retired exit words reach the model.** `exit` and `quit` are no longer commands, so a user who types them from habit sends them to OpenRouter as a message, spends a request, and gets a reply. The session stays open until `/exit` or end of input. The frontend should say which command ends the session when it starts.
- **Command state lives in the frontend.** The last prompt-token count and the context-window lookup are kept in `runRepl`'s closure, beside the readline loop. The classifier and the context line are in `src/core/commands.ts`, but the state they act on is not yet in the core (see Future Work).
- **`/context` numbers may not match the last line.** The count is from the last request that reported usage. A later request that failed is removed from the history but leaves the earlier count in place, and the output does not say which request it belongs to.
- **Response schemas can drift from OpenRouter.** The zod schemas in `src/openrouter.ts` are hand-written, and the tests use fixtures written from the same assumptions, so a change on OpenRouter's side passes the tests and fails only at run time. Specific risks: `choices` and `usage` are `optional`, not nullable, so a `null` there fails the whole stream; `ModelListingSchema` requires every entry of `data` to match, so one model with a `null` `context_length` makes `/context` fail for every model; and the error text from zod is printed verbatim, which is the escape-sequence risk under Security Concerns. The schemas and the hand-declared types (`StreamEvent`, `Usage`) are two sources of truth for the same shapes. The error also does not say which request failed.
- **No timeout and no cancellation.** A request that never completes leaves the prompt blocked with no way to abort it. `streamChat` should accept an `AbortSignal`, and the REPL should pass one that Ctrl+C triggers.
- **History grows without bound.** Every line and reply is appended and resent in full, so each request grows with the session, eventually exceeding the model's context window and raising cost. No `max_tokens` is set, so a single reply is also unbounded.
- **Write errors are not handled inside `runRepl`.** An error thrown by `output.write` inside the `try` is caught and reported by writing to the same broken stream, which can throw again out of `runRepl`.
- **No formatter configured.** The linter enforces size and correctness rules, but not formatting, so style can still drift between files.
- **Unpinned development dependency.** `@types/bun` is set to `latest`, so type checks can change without a code change.
- **`typescript` is only a peer dependency.** A fresh install does not provide the compiler the project's checks need unless the user has it installed.

## Security Concerns

Trust boundaries: everything read from stdin is untrusted text, and every line is sent to OpenRouter, a third party. The model's reply is also untrusted text. Vise has no file writes and no process spawning. The API key comes from `.env` and must never be echoed or logged.

- **Terminal escape injection.** In a terminal, readline echoes what the user types, and model replies are written verbatim. A line or reply containing ANSI or other control sequences can change the terminal's state (title, colours, cursor, clipboard on some terminals). The ideal control is to strip or escape control characters other than tab (and newline in replies) before they reach the output. This control is **missing**.
- **Prompt injection.** Model replies and earlier replies resent in history can contain instructions that the model then follows, and text from a pasted file or web page can carry them too. Today the model has no tools, so an injected instruction can only change the text shown. This is the risk to design for before any tool exists: any action taken from model output must be confirmed by the user, and must not be reachable from text the model produced alone. This control is **missing**.
- **Unbounded input.** A very long line or an unending stream is read into memory without a limit. The ideal control is a maximum line length, with a defined response when it is exceeded. This control is **missing**.
- **Model output is untrusted.** Model replies are written to the terminal as they stream, so they can carry the same escape sequences as input. The same control applies: strip or escape control characters other than tab and newline before writing. This control is **missing**.
- **Server error text is untrusted.** Error bodies from OpenRouter are printed verbatim in `error:` lines, with the same escape-sequence risk. They should be truncated and sanitized the same way. This control is **missing**.
- **Data exposure to a third party.** Every line and every earlier reply is sent to OpenRouter, and the history is resent in full each turn. Users must be told this, and sessions must not send content the user has not typed in this session (for example, file contents). A per-session cap on history and a `max_tokens` limit are the controls. Both are **missing**.
- **Unauthenticated spending.** Any process that can write to the REPL's stdin spends the user's OpenRouter credit. No rate or spend limit exists. This is acceptable for a local terminal tool but must be revisited if the REPL is ever exposed on a socket.
- **Future command execution.** When commands arrive that act on the user's machine or other services, every command must be explicit, must not be reachable by a free-form line that only echoes, and must be reviewed on its own. No such commands exist yet.
- **Secrets.** Vise must never log input lines to a file by default, since users may paste secrets. No logging exists yet.

## Future Work

- Move command interpretation into `src/core` as pure functions over `(state, line) -> (state, output)`, so the REPL is a thin driver. The line classifier is done (`src/core/commands.ts`); the REPL acts on its result. Next is moving the command state into the core.
- Move the context state into the core as well: the core keeps the last reported prompt tokens, receives usage through the same state transition as text, and formats the context line from `(used, total)`. The context window becomes a value the core asks for through a port, cached for the session, so `/context` can print the used count when the lookup fails.
- Put the ports (`Reply`, `ContextWindow`) in `src/core`, beside `Usage`, which already lives in `src/core/messages.ts`. The frontend and the model adapter then both depend on the core and not on each other, and the `echoReply` default leaves the frontend.
- Parse the model listing per entry and keep only the entries that match, so one malformed model cannot fail `/context`. Derive `StreamEvent` and `Usage` from the schemas with `z.infer`, and record real OpenRouter responses as test fixtures so the schemas are checked against the service, not against the tests' own assumptions.
- Make `scripts/check-files-per-dir.ts` count untracked files too (for example, from a directory walk that skips `node_modules` and `.git`).
- Add a formatter, and naming rules to the linter.
- Make the session a function of its inputs: the readline interface is created by the frontend and passed where needed, so tests can drive a session without touching real streams.
- Introduce a structured result type for command outcomes (success, usage error, unknown command) instead of ad-hoc strings, with errors that say what failed, where, why, and what the user can do.
- Give the model adapter a structured error type (`ModelError` with kinds such as `http`, `stream`, `parse`, `truncated`) so each failure says what failed, where, why, and what to do.
- Thread an `AbortSignal` from the frontend through the reply function into `fetch`.
- Add a maximum line length and control-character handling before echo, applied to input and to model output.
- Bound the history sent per request, and set `max_tokens`.
- Pin dev dependencies to specific versions, and declare `typescript` as a dev dependency so checks run on a clean install.

## Performance

These are the obvious concerns only. Measure with a profiler before optimizing.

- Each streamed text delta is written with a separate `write` call. Fine at interactive speed; large replies would benefit from buffering output per chunk.
- Long lines are held whole in memory and in the history. This is bounded only by the line-length limit once it exists.
- `/context` fetches the full model listing on every call, which is a large response for one number. Cache the context window for the session.
- Startup cost of `bun run` is dominated by the runtime, not by this code.
