# Architecture

This is the canonical design document for Vise. It describes the architecture the project is working toward, not the current code. Keep it ahead of the implementation: when the code catches up, advance this document. It is not a changelog; completed work lives in the git log.

Vise is a Bun + TypeScript command-line application. The target shape is a small, pure core that interprets lines of input, with a thin terminal frontend that owns all I/O.

## Definitions

- **Core**: the pure logic that turns an input line into a result (line classification and command output, and later the command state). Core code takes data in and returns data out. It never reads stdin, writes stdout, reads the environment, or touches the clock or filesystem without being passed the capability.
- **Frontend**: code that connects the core to a medium. The terminal frontend is the only one today. It owns readline, prompts, and stream handling.
- **Composition root**: the single entry point that wires a frontend to the core and reads the process environment. It is the only place that touches `process`.
- **Session**: one run of the REPL, from start until `/exit` or end of input.
- **Command**: a line whose trimmed text starts with `/`. Commands are interpreted by the core and never sent to the model. The set is `/exit`, `/context`, and `/compact` today; the core classifies any other `/` line as `unknown-command`, and the frontend reports it as an error.
- **Exit command**: a line whose trimmed text is `/exit`. The core's line classifier recognises it; after it, the session accepts no further lines, even if they arrived in the same chunk of input. Bare words such as `exit` or `quit` are ordinary lines.
- **Context command**: a line whose trimmed text is `/context`. It reports the prompt tokens the provider counted for the most recent request that reported usage, out of the model's context window. Both numbers come from the provider, not from an estimate. Before any request has reported usage it reports that no request has been sent. After a compaction it reports that the size is unknown until the next request, because the counted size described the history that was replaced; it never says that no request was sent when one was.
- **Compaction**: replacing the history with a summary of it. The summary is requested from the model by sending the whole history followed by a fixed request. The new history is the summary, kept as a user message, followed by the most recent messages. Compaction runs on `/compact`, and automatically before a message when the last prompt tokens reached 80% of the context window. The rules live in `src/core/compaction.ts`. Building the request and the new history, and the 80% check, are pure. `compact` requests the summary through the `Reply` port, which is its only I/O. The summary is model output, so it is untrusted text, and the user must be able to read it before it replaces the history (see Security Concerns).
- **Line**: one unit of input without its terminator. Lines are processed in order and each is handled at most once.

Invariants:

1. Once a session has ended, no line after the exit word produces output or side effects.
2. The core never performs I/O. A frontend is the only code that reads or writes streams.
3. Every line the frontend accepts produces exactly one response, or none when the session has ended. A message line that triggers compaction produces the compaction notice (or its error) and then the reply, so a message is not always one response. The notice is the only extra output, and it appears before the reply.
4. Behaviour depends only on the input stream and the arguments passed in, so the same input always gives the same output. The model adapter, the context-window lookup, and the compaction summary are the exceptions: their replies come from the network, so the adapter must make every reply it returns either complete or an error, never a silently truncated success, and the lookup must do the same. A compaction summary that is incomplete or wrong changes every later request, so a failed or truncated summary must leave the history unchanged.
5. Commands are never sent to the model as text. A `/` line is consumed by the core whether or not it is known. A command may make the core send the history to the model (`/compact` does), but never the command text itself.
6. A session releases its streams before it returns. On every exit path (end of input, `/exit`, a stream error, or a reply that throws), the readline interface is closed and the frontend's error listeners are removed, so the process can end without waiting for more input.
7. A stream error that arrives after a session has returned is reported by the composition root with a readable message and exit code 1. It is never an uncaught exception with a stack trace.
8. The prompt prefix is append-only between compactions. The history changes only by appending a user message and then an assistant reply, or by a compaction. A failed request leaves no trace in the history, so the next request begins with the same messages as the last completed one. The cache breakpoint is a marker on the last message of each request and never changes which messages are sent, so the provider can reuse the cached prefix on every turn that does not compact.

## Structure

Target layout:

```
index.ts            composition root: wires process.stdin/stdout and OPENROUTER_API_KEY to the REPL and the model (entry point, keeps `bun run index.ts`)
src/openrouter.ts   model adapter: streams a chat completion from OpenRouter over HTTPS (performs network I/O, passed to the REPL as a function)
src/core/           pure line classification and command interpretation (no node: imports except types)
src/repl/           terminal frontend: readline, prompt, session lifecycle
src/core/messages.ts  shared data types and ports (ChatMessage, Usage, Reply, ContextWindow)
src/core/result.ts    Result type (ok / err) for failures that are returned, not thrown
src/core/compaction.ts  compaction state (Conversation): the summary request, the compacted history, the 80% check, and compact
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
- **The frontend has default model stand-ins.** `runRepl` defaults its reply function to an echo, so a caller that omits it gets fake model behaviour without an error. Its context-window default returns an `err` Result, so `/context` reports that no window is configured instead of showing a real limit. The composition root should pass both explicitly.
- **Stream errors end the session as a failure, but not until the reply finishes.** `runRepl` listens for `error` on input and output, and on the readline interface, where readline re-emits input errors. It aborts the interface and returns `err`, which `index.ts` prints before exiting with code 1. The abort does not reach the reply, so an error that arrives during a model stream is reported only after the stream ends or fails.
- **Partial replies stay on screen.** When a model stream fails (an `{"error": ...}` event, or the connection ending before `data: [DONE]`), `streamChat` yields an `err` result and `runRepl` drops the user line from the history, so no truncated answer is recorded. The text already printed is not marked as incomplete, and nothing tells the user it was discarded.
- **Retired exit words reach the model.** `exit` and `quit` are no longer commands, so a user who types them from habit sends them to OpenRouter as a message, spends a request, and gets a reply. The session stays open until `/exit` or end of input. The frontend should say which command ends the session when it starts.
- **The compaction trigger and usage recording live in the frontend.** `compact` and the `Conversation` type are in `src/core/compaction.ts`, and `compact` clears the prompt-token count by returning a new `Conversation`. But `runRepl` still holds the `conversation` variable, decides when to compact (`compactIfFull` checks `needsCompaction` against the context window it was given), and records the usage the reply reports into the conversation. The frontend therefore still owns the rule that decides when history is compacted, which the core should own (see Future Work).
- **The stored prompt size is only set by completed requests.** A completed request records its size and clears the compacted flag. A compaction clears the size, so `/context` says the size is unknown since the compaction rather than "no request sent yet". A failed request does not record its size. A failed compaction keeps the conversation unchanged, so the next message tries again and prints an error. The automatic check still uses the size of the previous request, not the size of the request about to be sent, so a message that adds many tokens can overflow the window before the next check.
- **`/context` numbers may not match the last line.** The count is from the last request that reported usage. A later request that failed is removed from the history but leaves the earlier count in place, and the output does not say which request it belongs to.
- **Response schemas can drift from OpenRouter.** The zod schemas in `src/openrouter.ts` are hand-written, and the tests use fixtures written from the same assumptions, so a change on OpenRouter's side passes the tests and fails only at run time. Specific risks: `choices` and `usage` are `optional`, not nullable, so a `null` there fails the whole stream; `ModelListingSchema` requires every entry of `data` to match, so one model with a `null` `context_length` makes `/context` fail for every model; and the error text from zod is printed verbatim, which is the escape-sequence risk under Security Concerns. The schemas and the hand-declared types (`StreamEvent`, `Usage`) are two sources of truth for the same shapes. The error also does not say which request failed.
- **No timeout and no cancellation.** A request that never completes leaves the prompt blocked with no way to abort it. `streamChat` should accept an `AbortSignal`, and the REPL should pass one that Ctrl+C triggers.
- **Compaction keeps roles alternating by merging.** When the first kept message is a user message, the summary is merged into it, so the compacted history starts with one user message. If the first kept message is an assistant message, the summary stands alone as a user message. Either way the roles alternate.
- **The summary is invisible.** Summary chunks are collected without being written, so the user never sees what the model kept, and the "history compacted" line does not say what was dropped. Everything older than the last six messages is gone from the session with no record shown to the user.
- **The summary is a user message with model-written content.** Once a summary is in the history, every later request carries it with user-level authority, so an instruction in a reply that the model summarised is carried forward into every later request. See Security Concerns.
- **History is compacted, not bounded.** Compaction runs on `/compact` and before a message once the last prompt reached 80% of the window. Between compactions the history is resent in full, and no `max_tokens` is set, so a single reply is unbounded. After a compaction, `/context` reports the size as unknown until the next request (see Definitions).
- **A reply that throws is caught at the reply boundary.** `runRepl` turns a thrown reply error into a failure for that turn, the same as an `err` value. The adapters return `err` values and do not throw, so this path is a safety net, not the normal route. The catch assumes the thrown value is an `Error`: a thrown string prints `error: undefined` (verified). A thrown value must be normalised to an `Error` before it becomes a failure. `compact` and the REPL's catch normalise the thrown value, but `src/openrouter.ts` still casts `(error as Error).message` in its three catch blocks, so a thrown string there prints `undefined` in the message. The `ContextWindow` calls in `showContext` and in `compactIfFull` sit outside that boundary, so a throwing context lookup would reject `runRepl` instead of returning an error for `/context` or for the message being sent.
- **A stream error after the session has returned is uncaught.** The `finally` removes the frontend's error listeners on input and output, so an `error` emitted on either stream after `runRepl` returns has no listener. Bun then exits with status 1 and prints a stack trace (verified with a stream that errors after `/exit`, and with output that errors after `/exit`). The process does end, and the failure is not lost, but it is not reported as a session failure and no message is shaped for the user. Invariant 7 is the target.
- **No formatter configured.** The linter enforces size and correctness rules, but not formatting, so style can still drift between files.
- **Unpinned development dependency.** `@types/bun` is set to `latest`, so type checks can change without a code change.
- **`typescript` is only a peer dependency.** A fresh install does not provide the compiler the project's checks need unless the user has it installed.

## Security Concerns

Trust boundaries: everything read from stdin is untrusted text, and every line is sent to OpenRouter, a third party. The model's reply is also untrusted text. Vise has no file writes and no process spawning. The API key comes from `.env` and must never be echoed or logged.

- **Terminal escape injection.** In a terminal, readline echoes what the user types, and model replies are written verbatim. A line or reply containing ANSI or other control sequences can change the terminal's state (title, colours, cursor, clipboard on some terminals). The ideal control is to strip or escape control characters other than tab (and newline in replies) before they reach the output. This control is **missing**.
- **Prompt injection.** Model replies and earlier replies resent in history can contain instructions that the model then follows, and text from a pasted file or web page can carry them too. Today the model has no tools, so an injected instruction can only change the text shown. This is the risk to design for before any tool exists: any action taken from model output must be confirmed by the user, and must not be reachable from text the model produced alone. Compaction is a second persistence path: a summary written by the model becomes a user-role message in every later request, so an injected instruction survives compaction with more authority than the reply it came from. The ideal is that a summary is shown to the user and confirmed before it replaces the history, and that it is marked in the request as model-written context rather than as the user's words. These controls are **missing**.
- **Unbounded input.** A very long line or an unending stream is read into memory without a limit. The ideal control is a maximum line length, with a defined response when it is exceeded. This control is **missing**.
- **Model output is untrusted.** Model replies are written to the terminal as they stream, so they can carry the same escape sequences as input. The same control applies: strip or escape control characters other than tab and newline before writing. This control is **missing**.
- **Server error text is untrusted.** Error bodies from OpenRouter are printed verbatim in `error:` lines, with the same escape-sequence risk. They should be truncated and sanitized the same way. This control is **missing**.
- **Data exposure to a third party.** Every line and every earlier reply is sent to OpenRouter, and the history is resent in full each turn. Users must be told this, and sessions must not send content the user has not typed in this session (for example, file contents). A per-session cap on history, compaction that the user can see, and a `max_tokens` limit are the controls. All three are **missing** or partial: compaction exists, but its summary is not shown, and no `max_tokens` is set.
- **Unauthenticated spending.** Any process that can write to the REPL's stdin spends the user's OpenRouter credit. No rate or spend limit exists. This is acceptable for a local terminal tool but must be revisited if the REPL is ever exposed on a socket.
- **Future command execution.** When commands arrive that act on the user's machine or other services, every command must be explicit, must not be reachable by a free-form line that only echoes, and must be reviewed on its own. No such commands exist yet.
- **Secrets.** Vise must never log input lines to a file by default, since users may paste secrets. No logging exists yet.

## Future Work

- Move command interpretation into `src/core` as pure functions over `(state, line) -> (state, output)`, so the REPL is a thin driver. The line classifier is done (`src/core/commands.ts`); the REPL acts on its result. Next is moving the command state into the core.
- Move the context state into the core as well: the core keeps the last reported prompt tokens, receives usage through the same state transition as text, and formats the context line from `(used, total)`. The context window becomes a value the core asks for through a port, cached for the session, so `/context` does not fetch the full model listing on every call. The core, not the frontend, decides what `/context` prints when the lookup fails, and it prints the used count in that case.
- Remove the `echoReply` default from the frontend. The ports already live in `src/core/messages.ts`, so the frontend and the model adapter both depend on the core only. The composition root should pass `Reply` and `ContextWindow` explicitly.
- Parse the model listing per entry and keep only the entries that match, so one malformed model cannot fail `/context`. Derive `StreamEvent` and `Usage` from the schemas with `z.infer`, and record real OpenRouter responses as test fixtures so the schemas are checked against the service, not against the tests' own assumptions.
- Make `scripts/check-files-per-dir.ts` count untracked files too (for example, from a directory walk that skips `node_modules` and `.git`).
- Add a formatter, and naming rules to the linter.
- Make the session a function of its inputs: the readline interface is created by the frontend and passed where needed, so tests can drive a session without touching real streams.
- Introduce a structured result type for command outcomes (success, usage error, unknown command) instead of ad-hoc strings, with errors that say what failed, where, why, and what the user can do.
- Give the model adapter a structured error type (`ModelError` with kinds such as `http`, `stream`, `parse`, `truncated`) so each failure says what failed, where, why, and what to do.
- Thread an `AbortSignal` from the frontend through the reply function into `fetch`.
- Add a maximum line length and control-character handling before echo, applied to input and to model output.
- Move the compaction trigger and the usage recording into `src/core/compaction.ts` as state transitions over `Conversation`: `recordUsage(conversation, usage)`, and `compactIfNeeded(conversation, reply, contextWindow)` returning the next conversation plus what to show. `runRepl` then only reads a line, calls the transition, writes the notice it returns, and holds no prompt-token count of its own. The frontend shows the notice and the summary and decides nothing about history.
- Show the summary to the user and let them confirm it before it replaces the history, and mark it as model-written context in the request.
- Bound the history per request with the compaction trigger applied to the size of the request about to be sent, not the previous one. Set `max_tokens`.
- Cache the context window for the session, so the check before each message does not fetch the model listing.
- Pin dev dependencies to specific versions, and declare `typescript` as a dev dependency so checks run on a clean install.
- Handle late stream errors: `runRepl` accepts an `onLateError` callback from the composition root, and the frontend keeps a listener on input and output after the session ends that forwards to it. `index.ts` prints the error and exits 1. This meets Invariant 7 without leaving the streams unobserved.
- Remove the `(error as Error)` casts in `src/openrouter.ts` and normalise thrown values there the way `compact` does (`error instanceof Error ? error : new Error(String(error))`). Bring every context-window lookup inside a boundary.

## Performance

These are the obvious concerns only. Measure with a profiler before optimizing.

- Each streamed text delta is written with a separate `write` call. Fine at interactive speed; large replies would benefit from buffering output per chunk.
- Long lines are held whole in memory and in the history. This is bounded only by the line-length limit once it exists.
- `/context` fetches the full model listing on every call, which is a large response for one number. Cache the context window for the session. The same lookup runs before every message once a size is stored, so the cost is paid on the message path too.
- Compaction resends the whole history once more, plus the summary request, so it roughly doubles the tokens for that turn. It is rare, but a long session can hit it repeatedly.
- **Prompt cache.** The guiding principle is to hit the provider's prompt cache as often as possible. `src/openrouter.ts` marks the last message of each request with `cache_control` (`withCacheBreakpoint`), so the next turn reuses the cached prefix. A probe against OpenRouter with `anthropic/claude-haiku-5.5` showed 7,204 cached tokens on the second identical prefix with the marker, and 0 without it. The app does not report cache numbers yet. Appending to the history keeps the prefix stable; compaction is the only intended break (Invariant 8). The probe covered two identical requests. It has not covered the turn after a completed one, where the previous last message is sent as plain text rather than with the marker, so the cross-turn case should be probed with two real turns. Provider caches are short-lived (about five minutes on Anthropic models), so a pause longer than that loses the prefix. Each compaction writes one cache entry for the whole history plus the summary request, which is a write cost once per compaction. Reading `cache_read` and `cache_write` from `usage` would make the hit rate measured rather than assumed.
- Startup cost of `bun run` is dominated by the runtime, not by this code.
