# vise-cli Architecture

`vise-cli` is the terminal frontend, package `Vise` (the executable keeps its name). It reads
lines from stdin, turns them into `Request`s, and draws `UiEvent`s through `render.rs`.

## Structure

```
src/
  main.rs            wiring: reads .env and LLAMA_API_KEY, takes the working directory, creates the `Stop`, installs Ctrl+C,
                     builds `Parts` (the provider, the tool runner, the conversation and the sessions folder), and its `Engine`; then `start`, the REPL loop, and `shutdown`. `--new` skips the resume. Fatal startup errors
                     go to exit_with.
  repl.rs            the input loop: reads a line, turns it into a `Request` (`slash::command`, or a chat line), sends it
                     to the engine, and ends the run on `/exit`, the end of input, or a write that failed
  repl/tests.rs      the loop's tests, run over a scripted provider and `Vec<u8>` streams
  terminal.rs        `TerminalFrontend`: shows `UiEvent`s on stdout and stderr (`error: ` prefix, `Reply` in green), words the
                     query results, the changes and their empty-list hints, draws
                     the live reply through `Render`, and asks for approvals by reading `y` or `yes` from the input it also
                     reads lines from
  render.rs          draws provider Events: one status line, answer text, a `tool:` line per call, and the end of each
                     request. Subagent tool lines come in through `on_subagent_event`, indented under the parent's. Owns
                     the output the answer and the approval prompt share.
  style.rs           terminal colors: `Color`, `enable_stdout` (called once, from `main`), `allowed`, `paint`, and `Errors`,
                     the stderr wrapper that paints each `error:` line red and writes whole lines
  interrupt.rs       Ctrl+C: installs the handler. A press asks the running work to stop through the `Stop` switch; a press
                     the switch refuses, because no work runs or a stop is already pending, quits with status 130.
```

## Invariants

### Interrupts

- Ctrl+C never ends the process while a turn, a request, a tool round, or the startup lines are running. The first press
  asks that work to stop; the work ends at its next check, whether after a reply's chunk, between tool rounds, or when the
  tool returns. Nothing in progress is killed, so a command that is running finishes first.
- A stopped turn is committed with the prepared user message, the tool rounds that finished, and the text the reply had
  reached, followed by a `[the turn was interrupted]` line. It is autosaved like any other turn. Its after-turn lines do
  not run, and no follow-up turn follows it. The line is not resent.
- Every other Ctrl+C quits: at the prompt, after a stop is already asked for, and during the shutdown lines. The exit status
  is 130.

### Display

- Color is decided once at startup by `style`, per output stream, from whether that stream is a terminal and whether
  `NO_COLOR` is set. Escape codes are written only by `style::paint` and `Errors`, so a redirected stream never receives them.
- `interrupt` (terminal crate) owns the Ctrl+C handler and the policy for a refused press. Nothing else installs a handler or calls `exit` for an interrupt.
- Tool output goes to the model as text. The backend never writes to a terminal: it emits `UiEvent`s to the `Frontend` it is
  given, and asks it for each approval. The terminal frontend draws them: `render` prints answer text as it streams, prompt
  and thinking progress, one `tool:` line per call, and the end of each request; notices and errors go to stdout and stderr.
  Approval prompts share the same output as `render`.

## Dependencies

An arrow means "may depend on". Dependencies only point one way; there are no cycles.

```
vise-cli -> vise-core (its public modules only); the core never imports the terminal crate
  main -> the wiring of the terminal modules and of vise_core::{environment, parts, stop}
  interrupt -> vise_core::stop, `ctrlc`
  repl -> terminal, vise_core::{engine, command, frontend, slash}
  terminal -> render, style, vise_core::frontend
  render -> style, vise_core::provider::types (Event)
  style -> std only, a leaf: it knows no other module
```

## Open Problems

### Display

- **Windows console VT mode is not enabled.** `style` writes ANSI sequences, but nothing sets `ENABLE_VIRTUAL_TERMINAL_PROCESSING`
  and the project has no Windows API dependency. A host that does not already enable it shows the raw codes. This is unverified
  on each host; the fix belongs in a platform module, not in `style`.
- **Colors are process-global.** `style` keeps one `AtomicBool`, set at startup, so `paint` reads a hidden flag rather than the
  `Render` or `Errors` that writes. Colored output cannot be tested without touching that flag. The ideal is a `Style` value that
  `main` builds and passes to `Render` and `Errors`.
- **Partial stderr lines wait for a newline.** `Errors` holds text until a `\n`, and `Drop` writes what is left. Text written
  without a newline is invisible until one arrives, and is lost if the process exits without dropping `Errors`. `interrupt.rs`
  also writes with `eprintln!`, which bypasses `Errors`.

### The frontend boundary

- **The wording exists twice.** `vise-cli/src/terminal.rs` and `vise-gui/src/words.rs` each turn the typed query results and
  changes into English. A change to a sentence must be made in both. The shared home could be a text-formatting module in
  `vise-core` that a text frontend opts into, with each frontend's own hint syntax passed in.
- **`main` exits 0 when the REPL fails.** A stdin or stdout failure inside the REPL is printed and the process returns normally.
