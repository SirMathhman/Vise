# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server with an OpenAI-compatible
`/v1/chat/completions` endpoint. The model can read and write files under the working directory
through tools; the user approves every write.

This document describes the design and lists, once, where the code does not yet meet it (Open
Problems). It is a reference, not a changelog: finished work is removed, not annotated.

## Definitions

- **Turn**: one user line, the tool exchanges the model makes while answering it, and the final
  assistant reply. A turn is committed to the conversation whole or not at all.
- **Message**: an enum with one variant per role: `System`, `User`, `Assistant` (content and the tool
  calls it requested), and `Tool` (content and the id of the call it answers). A `Tool` message always
  has a call id.
- **Conversation**: the committed history sent to the model on every turn. Only `session` changes it.
- **Context message**: the leading `system` message describing the host environment (today, the working
  directory). It is gathered at startup, sent on every turn, and removed only by compaction's own rules.
- **Provider**: a backend that turns a conversation into one turn, reports the context size, and writes
  summaries. llama.cpp is the only provider.
- **Prompt tokens**: the prompt token count the server reports for the last request of a turn. It is
  the figure that grows toward the context size.
- **Context size**: the token capacity of the configured model, read from the server once per session.
- **Compaction**: replacing older history with a summary the model wrote. The result keeps the context
  message, one summary (an assistant message with no tool calls), and the last two turns. Compaction
  runs on `/compact`, and before a turn when the last prompt tokens reach 80% of the context size.
- **Tool catalogue**: the text listing every tool with its arguments. It is joined to the leading system
  message of each request only, never stored in the conversation, and it lists disabled tools too, so it
  never changes during a session.
- **Enabled tools**: the tools the model may call. The runner holds the set, `/tools` changes it, and each
  request's grammar is built from it. A disabled tool is neither offered nor run.
- **Tool note**: the line `[Tools enabled: ... Tools disabled: ...]` naming every tool and its state. It is
  how the model is told the enabled set.
- **Tool call form**: a reply consisting of `<tool_call>`, a JSON body with `name` and `arguments`, and
  `</tool_call>`. It is the only reply form that runs a tool. Any other reply is text.
- **Write**: a tool call that changes the filesystem or runs or stops a program (`create_file`,
  `create_directory`, `edit_file`, `run_powershell`, `kill_background`). A write runs only after the user
  approves it. A declined write is reported to the model as an error and changes nothing.
- **Background task**: a PowerShell command that keeps running after its turn's tool call returns. It
  gets an id, its output is collected while it runs, and the model reads that output with
  `read_background` and stops it with `kill_background`. Background tasks are stopped when the session ends.
- **Profile**: a named set of instructions, kept as `profiles/NAME.txt` under the working directory. The
  user selects one with `/profile NAME`. Its text, under a heading that names it, is prepended to the next
  user message only. The system prompt never changes.
- **Wire type**: a struct matching the JSON shape of a provider request or response. Wire types never
  leave `provider::llama_cpp`.

## Invariants

- A successful turn appends its user message (with any profile text), its tool exchanges, and its reply
  together. A failed turn leaves the conversation as it was. It does not undo files the turn changed (see
  Open Problems).
- `Turn::new` checks the shape of every turn: a user message first; then zero or more rounds, each an
  assistant message with tool calls followed by exactly one `Tool` message per call, in order; then a
  final assistant message with no tool calls.
- A turn may make at most `MAX_TOOL_ROUNDS` (10) tool rounds. Exceeding the limit fails the turn.
- Overflow handling:
  - A request the server rejects because it exceeds the context (error type
    `exceed_context_size_error`) is `ContextFull`. So is a tool round whose reply reports a prompt at
    80% of the context size; that round's tools are not run.
  - `ContextFull` is retried once, after compaction, from the compacted history.
  - A turn that has attempted a write is never retried. If the context fills after a write, the turn
    fails with `ContextFullAfterChange`.
- Other HTTP errors: a 400 that is not an overflow is `Rejected`, carrying the server's message or the
  raw body. Connection and read failures are `Transport`.
- Compaction keeps the context message, one summary, and the last two turns, in that order. An empty
  summary is an error and leaves history unchanged.
- A drop is the fallback when the summary request itself does not fit. It removes the summary if there
  is one, otherwise the oldest turn, and reports how many messages were removed.
- Paths: a read resolves its path with `confine` (the path must exist and lie under the working
  directory). A file write resolves its path with `confine_new`, which resolves `..` lexically and
  requires the deepest existing ancestor to lie under the working directory. A path outside the working
  directory is an error, and nothing is read or written.
- `run_powershell` is not confined. Its command runs in the working directory with the user's full
  permissions, and can read, write, or delete anything the user can. The approval prompt is the only
  gate, and it shows the command in full.
- `run_powershell` requires a `timeout_seconds` between 1 and 30. A command still running when that wait
  ends becomes a background task, and the command is not stopped. A command with `background` true starts
  as a background task at once. Each task keeps at most its last 100 KB of output.
- A read of a background task takes the offset the model last received and returns the output after it,
  with the next offset. The task holds no read position, so a read repeated by a retried or discarded turn
  returns the same output again. Output is decoded at character boundaries, so no character is split
  across two reads.
- Stopping a background task (`kill_background`) ends every process the task started, including those
  whose parent has already exited. On Windows the task's processes run in a Job Object with
  kill-on-close, so ending the job, or closing its last handle, ends them all.
- A background task ends with the session, however the process exits: normal return, error, or
  interrupt.
- The approval text for `kill_background` names the task's command and whether it is still running, not
  only its id. The user approves what will stop, not a number.
- A write runs only after the user approves a description of it. The default is no: only `y` or `yes`
  approves.
- Slash commands (`/compact`, `/context`, `/exit`, `/help`, `/tools`, `/profile`) are never sent to the
  model. Every other line is, including `exit`, `quit`, and unknown slash commands.
- A profile is chosen by name only. The name must be letters, digits, `-` or `_`, so it cannot leave the
  profiles folder. The selected profile is sent with the next user message whenever the history does not
  carry it (`profile::carried`), so a failed turn keeps it for the retry. Once committed, its text stays in history until
  compaction or a dropped turn removes it.
- Each request has no `tools` field. It carries a grammar built from the enabled tools, which fixes the
  reply to a thinking block followed by plain text or one tool call to an enabled tool. Plain text cannot
  contain the `<tool_call>` marker.
- Only a tool call form runs a tool. A plain-text reply that names a tool runs nothing.
- A disabled tool does not run, even if a reply names it. The grammar stops its generation, and the runner
  refuses it again before it runs.
- Enabling or disabling a tool changes no committed message, and enabling a tool does not approve its writes.
  Each write still needs approval.
- The model always knows the enabled set from the history it is sent. A user message carries the tool note
  whenever the history does not already state the current set. The note is committed with that message, and
  compaction or dropping a turn ends the statement it carried, so the next user message repeats it.
- Each reply is capped at `max_tokens` 8192, so a reply that never closes its thinking block ends.
- API keys are never printed, logged, or put in error text.
- No function panics on bad input or failed I/O; fallible steps return `Result`.

## Structure

```
src/
  main.rs            wiring: reads .env and LLAMA_API_KEY, takes the working directory, builds the
                     provider and tool runner, runs the REPL. Fatal startup errors go to exit_with.
  repl.rs            the input loop over generic BufRead/Write. Parses and runs slash commands
                     (including `/tools`, `/tools enable NAME`, `/tools disable NAME`, `/profile`,
                     `/profile NAME`), holds the selected profile until a turn succeeds,
                     decides when to compact, retries a turn that reports ContextFull once, asks
                     for approval of writes, and writes replies and notices
  session.rs         Message, Turn (checked shape), Conversation (committed history, prompt tokens of
                     the last committed turn, compaction, drop_oldest_turn), over_budget (80%)
  environment.rs     gathers host facts as plain data (working directory)
  error.rs           ProviderError, SessionError, MAX_TOOL_ROUNDS
  profile.rs         lists the profiles folder's .txt files and loads one by a validated name
  provider/
    mod.rs           declarations only
    types.rs         trait Provider: complete, context_size, summarize
    llama_cpp.rs     the HTTP client; wire structs; the tool-round loop; the 400 mapping
                     (bad_request); the /v1/models lookup; conversion between JSON arguments and Values;
                     the catalogue joined to the first system message of each request; the tool note
                     prepended when the history does not state the enabled set (checked, not stored)
    grammar.rs       builds the GBNF grammar from the enabled tool names: thinking block, then text that
                     cannot contain the `<tool_call>` marker, or one call. Sent with each request.
    prompt.rs        the tool catalogue text, from every ToolSpec, enabled or not; the tool note
  tools/
    mod.rs           registry: specs(), call(name, values) -> Invocation; declares its children
    types.rs         ToolSpec, Param, ParamType, Value, Arguments, Invocation, ToolCall, ToolError,
                     ToolRunner (run, enabled, set_enabled)
    runner.rs        WorkspaceTools: runs an Invocation, refuses a disabled one, asks for approval first
                     when it writes, holds the enabled set, and owns the background tasks, ending them
                     when it is dropped
    run_powershell.rs  runs one Windows PowerShell command in the working directory; after its
                     timeout it becomes a background task
    read_background.rs  returns a background task's output after the offset the model passes
    kill_background.rs  stops a background task and every process it started
    jobs.rs          the background tasks' bookkeeping: ids, commands, output (capped at 100 KB), and
                     read offsets. It holds no OS process handling.
    process/         the one place that starts, stops, and reaps OS processes; Windows only today
                     (Job Object, kill-on-close). Another platform adds a sibling module here.
    fs/              the file tools, each one file, with path.rs
      mod.rs         declares its children
      path.rs        confine (existing paths) and confine_new (paths a write creates)
      list_directory.rs  recursive listing to a depth of 1 to 5
      read_file.rs   a 1-based line range, capped at 500 lines or 100 KB
      create_file.rs a new file; fails if the path exists
      create_directory.rs  creates missing parents; succeeds if the directory exists
      edit_file.rs   one exact, unique replacement in an existing file
```

Dependencies (an arrow means "may depend on"; there are no cycles):

```
main -> repl, session, provider::llama_cpp, tools::runner, environment, error
repl -> provider::types, session, tools::types, profile, error
profile -> std only
provider -> session (Message, Turn, over_budget), tools (registry and types), error
session -> environment, tools::types (ToolCall only)
tools -> tools' own types, std (no provider, session, HTTP, or serde)
tools::process -> std and the platform binding (Windows Job Object); nothing outside tools::process
                  names a platform API
```

## Rules

- `provider::llama_cpp` is the only module that knows HTTP, `ureq`, the endpoint, the wire shapes, or
  the JSON form of tool specs and calls. Only `provider::grammar` knows the call syntax as a grammar, and
  only `provider::prompt` knows the catalogue's text and the tool note's text.
- The provider sends the grammar built from `ToolRunner::enabled()` on every request, and never a `tools`
  field. The provider never compares tool names: refusing a disabled tool is the runner's job.
- `tools` never parses JSON and never imports the provider or the session. The provider decodes a
  model's arguments into plain `Value`s (text, integer, or `Unsupported`) and passes them with the tool
  name to `tools::call`. `call` finds the spec, checks the values against its parameter types, and calls
  the spec's own `bind` function. The provider never compares tool names.
- `Value` is text, integer, boolean, or `Unsupported`.
- Adding a tool takes: a file with its `SPEC`, `bind`, and `run`; one `Invocation` variant; one arm in
  `runner.rs`; one arm in `Invocation::writes` (an exhaustive match, no wildcard); and one entry in the
  `SPECS` list. The provider and session do not change.
- A mapping from an HTTP status and body to a `ProviderError` is a pure function, tested without a
  server.
- `Turn` is built only in the provider's tool loop, and its shape is enforced by `Turn::new`.
- `Conversation` is the only holder of committed messages. `repl` reads them through
  `messages()`, `prompt_tokens()`, and `context_size` on the provider.
- The session owns the compaction budget (`over_budget`, `needs_compaction`). The provider reports
  `ContextFull`; it does not change history.
- `/context` prints the context message, then `<prompt tokens> / <context size>`. A failed size lookup is
  reported on the error stream.
- Tool output goes to the model as text. The REPL prints only replies, notices, and errors.
- Limits per module: 100 lines per function, 500 code lines per file, 10 files per directory.
- Recursion is allowed only within one module and only when bounded by a parameter (the directory walk
  is bounded by depth).
- A parent `mod.rs` declares its children and holds the registry. Types several siblings share live in a
  leaf module (`error.rs`, `tools/types.rs`).

## Open Problems

Each item is a gap between the design above and the code, or a decision the code makes that the design
does not allow.

Turn and history
- **Profile listing and selection disagree.** `profile::names` lists every `.txt` file, including names
  `load` rejects (such as `my notes.txt`), so `/profile` shows a name it then refuses.
- **Profile text is unbounded.** `profile::load` reads the whole file. A large profile is committed and
  resent on every later turn.
- **No way to clear a profile.** Once chosen, a profile stays until another is chosen or the process ends.
  There is no "no profile" form.
- **Failed turns forget their writes.** A turn that writes and then fails (round limit, transport error,
  `ContextFullAfterChange`) commits none of its messages. The files stay changed, the next turn does not
  know it, and the user sees only the error. A failed turn must record the writes it applied, and its
  error must name the changed paths. The same holds for background tasks: a task started in a failed turn
  keeps running, and its id is lost with the turn.
- **Replayed reads lose output.** `read_background` advances the task's read position when it runs. If the
  turn is then retried (`ContextFull` before any write) or fails, the output that read returned never
  reaches the model, and the retry sees only what came after. Reads must take the offset from the
  conversation (see Invariants).
- **Turn shape is loosened.** `Turn::new` accepts a plain assistant message directly after the user
  message, and the test `summary_may_precede_tool_rounds` requires it. Nothing produces such a message:
  summaries live in `Conversation::compact`. The allowance and its test must go.
- **Summaries are discarded by their own check.** `summarize` returns `ContextFull` when the summary
  request's prompt is at 80%, even though the request succeeded. The caller then drops the oldest turn.
- **A drop is not a summary.** `Compaction::Dropped` removes history without a summary, so the one-summary
  rule does not hold after it. The `Compaction` outcome is defined in `repl.rs`, although `session` owns
  compaction.
- **Missing usage is zero.** When the server omits `usage`, the prompt count is stored as 0, and
  `/context` prints `0 / N` as if the conversation were empty. `drop_oldest_turn` also resets it to 0.
  The absence must be `None`, shown as unknown.
- **Repeated compaction is silent.** If the context is small or the summary large, every turn can trigger
  a full summary request, and nothing reports that compaction freed too little space.
- **Empty summaries are accepted by the REPL path.** An empty or whitespace summary is rejected by the
  provider, but the history it would replace is then dropped without a notice that says why.
- **Rewritten history.** Past tool calls are resent from decoded values. `Unsupported` becomes `null`, and
  invalid JSON becomes `{}`, so the model sees its own calls differently from what it wrote. Keep the
  arguments string verbatim, or show the model the lossy form as an error.
- **Oversized output is committed.** A `list_directory` call at depth 5 has no entry or byte cap, and its
  full output is committed and resent on every later turn. A single oversized tool result can therefore
  break the rest of the session. The same applies to any single turn that grows past the window.
- **Unrecoverable long lines.** A line over 100 KB makes every `read_file` range that starts on it fail
  with "line N is longer than 100 KB", and the message does not say that no range can read that line.
- **Whole-file reads.** `read_file` reads the entire file and splits every line before applying its cap,
  so a range near the end of a large file costs the full file.

Tool protocol
- **Two request formats.** A reply is requested as `<tool_call>` text, but earlier calls are resent as
  structured `tool_calls` with no `tools` field. The model sees its own calls in a form it is not asked to
  write. History should use the reply form, or the wire should use one form only.
- **Prose claims of tools are committed.** The grammar allows a plain reply such as `[Tool: run_powershell]`.
  Nothing runs, but the reply is committed, so later turns treat an action as done. The grammar cannot
  forbid this without forbidding ordinary text, so the turn must detect or label such replies.
- **The grammar does not constrain arguments.** Any JSON object passes the `arguments` rule. Bad arguments
  are found only in `tools::call`, after the model has chosen the call, and the model gets one error per
  round.
- **The grammar assumes a thinking block.** The root rule forces the closing `</think>` on every turn reply.
  It does not force the opening tag, so the chat template must open the block. A server or template that
  does not is unhandled.


Errors and the provider boundary
- **Misleading error for invalid JSON.** Invalid arguments decode to no arguments, so the model is told
  "missing 'path'" when its JSON was malformed. The error must name the malformed arguments.
- **Non-400 statuses look like connection failures.** A 5xx or other non-2xx reply is `Transport`, whose
  text says "check that the server is running". A `Status { status }` variant is needed for replies the
  server actually sent.
- **Empty server message.** `{"error":{"message":""}}` produces `Rejected("")`, and the user sees
  "the server rejected the request: ;". An empty or whitespace message must fall back to the raw body.
- **Overloaded `ModelNotFound`.** It means both "model not listed" and "listed without `n_ctx`". These
  need separate variants that name the model.
- **Stringly payloads.** `ToolError::Failed` and `ProviderError::Rejected` hold formatted text, and I/O
  causes are flattened, so callers and tests cannot match on the cause. `Transport` boxes an arbitrary
  error whose text can echo a response body.
- **Error homes.** `ToolError` lives in `tools/types.rs`, not `error.rs`. `MAX_TOOL_ROUNDS` lives in
  `error.rs` but belongs to the provider.
- **No timeouts, one request at a time.** A stalled server blocks the REPL. Connect, send, and read
  timeouts are not configured. Each request builds its own `ureq` request rather than sharing an agent.

Boundaries that the design places elsewhere
- **Approval passes through the provider.** `Provider::complete` and `ToolRunner::run` take the approval
  callback. Approval belongs to the REPL's prompt, so the runner should be built with an approver and the
  provider's signature should not carry it.
- **The budget threshold lives in the provider.** `provider::llama_cpp` imports `over_budget` and decides
  `ContextFull` from it. The session should pass a prompt limit in.
- **`repl` indexes the history.** `/context` reads `messages().first()`. `Conversation::context()` should
  be the only accessor.
- **Commands are parsed in `repl.rs`.** The design calls for a `commands` module with one table that
  drives both parsing and the `/help` text. Today the help text is written by hand.
- **Configuration is in `main`.** `main` loads `.env` and reads `LLAMA_API_KEY`. There is no `config`
  module. The endpoint and model are constants in `provider::llama_cpp`.
- **`main` exits 0 when the REPL fails.** A stdin or stdout failure inside the REPL returns normally.

Writes
- **The approval text is unescaped.** `describe` prints the path, content, and edit text as received.
  Control characters and carriage returns can hide or rewrite what the user approves.
- **Approval and confinement are separate steps.** The description shows the path, and `confine_new`
  resolves it when the write happens, so a symlink changed in between goes unseen. `confine_new` checks
  ancestors with `Path::exists`, which follows symlinks, so a dangling symlink is skipped. No test pins
  that case.
- **Writes are not atomic.** `create_file` creates the file before writing it, and `edit_file` rewrites
  the file in place. A failure in between leaves a partial file. Both should write a temporary file and
  rename it.

Commands (`run_powershell`)
- **Commands are not logged.** Every approval, write, and command must be recorded before it runs, with
  its text, working directory, approval, and exit status. `run_powershell` records nothing. Deletion and
  further execution tools wait for this.
- **The command runs only on Windows.** `run_powershell` starts `powershell.exe` with no platform split.
  The process handling belongs behind one module boundary, with the Windows implementation behind it, so
  another platform adds an implementation rather than branches. Today `jobs.rs` holds the spawning and
  the `taskkill` calls; they move to `tools::process`, which uses a Job Object.
- **Interrupts orphan background tasks.** Ctrl+C ends the process without unwinding, so
  `WorkspaceTools::drop` does not run and the PowerShell processes keep running. The Job Object's
  kill-on-close flag is the fix; until it exists the invariant does not hold.
- **Tree kill misses orphans.** `taskkill /T` finds processes by their parent link at stop time. A process
  whose parent has already exited is not found, and keeps running after `kill_background` reports it
  stopped.
- **Background tasks are invisible to the user.** Tool output goes only to the model, so the user learns of
  a task only if the model mentions it. Nothing lists tasks, and the user cannot see a task's output.
- **Kill approval shows only the id.** `describe` prints "stop background task N". The command and state
  are not shown, so the user approves a number, not the process it stops.
- **Output is decoded per read.** `Output::since` converts each read's bytes lossily. A character split by
  a read boundary or by the 100 KB cap becomes replacement characters.

Security-relevant gaps are listed under Security.

## Security

Trust boundaries:
- **Model output** is untrusted. It is printed to the terminal and may request tool calls. Tool names
  and arguments are validated like any other input.
- **Tool arguments** are untrusted. A path may be absolute, contain `..`, or name a symlink that leads
  outside the working directory.
- **Responses from the endpoint** are untrusted input to the parser: malformed JSON, unexpected shapes,
  and oversized bodies.
- **File and directory names** under the working directory are untrusted text. They can contain
  instructions to the model.
- **Profile files** are untrusted text. They sit in `profiles/` under the working directory, which an
  approved write can also change, and their text reaches the model verbatim.
- **The API key** lives in `.env` (git-ignored) and in the environment.

What untrusted input can reach:
- Model text reaches the terminal, where escape sequences can rewrite the screen or hide text.
- Read tools expose files under the working directory to the model. Write tools change them, each after
  the user's approval. `run_powershell` executes a command the user approved, with the user's full
  permissions and no path confinement.
- Tool results and summaries go back to the model. An injected instruction in a file name or in a summary
  persists through later turns, because committed history is resent.
- Error text may echo a server's 400 message or raw body, which must pass through the same sanitization as
  model text.

Controls:

| Control | Status |
| --- | --- |
| Path confinement for reads and writes | Met. A symlink swapped in after approval is not caught (Open Problems). |
| Write approval, default no | Met. Description is not escaped (Open Problems). |
| Terminal sanitization of model replies, approval text, and error text | Missing. |
| API key never printed, logged, or put in errors | Partly met. Error paths have not been audited. |
| Plain HTTP refused unless the endpoint is loopback | Missing. The endpoint is a loopback constant. |
| Size limits on user lines, profile files, and response bodies | Missing. Profile files are read whole (Open Problems). |
| Profile names restricted to letters, digits, `-`, `_` | Met. A name cannot leave the profiles folder. A symlink inside the folder is still followed. |
| Size limits on tool output | `read_file` and background task output. `list_directory` has none. |
| Limits on commands: time, process tree, output | Partly met. A foreground command waits at most 30 seconds, then becomes a background task. Stopping a task ends every process in its Job Object. Output is capped at 100 KB per task. Background tasks have no count limit. Interrupts and orphaned processes are not covered (Open Problems). |
| Approval shows what a stop will end | Missing. `kill_background` shows only the id (Open Problems). |
| The user can see what is running | Missing. No listing of background tasks (Open Problems). |
| Tool results and summaries marked as untrusted data | Missing. |
| Tools run only when enabled | Met. The grammar constrains the reply and the runner refuses a disabled call. |
| Plain text cannot run a tool | Met. Only the tool call form runs. A prose claim of a tool is committed without running (Open Problems). |
| Arguments checked per tool | Met in `tools::call`, after the grammar. The grammar accepts any object (Open Problems). |
| Enabling a tool | Accepted. `/tools enable` is the user's own action; each write still asks for approval. |
| Logging of approvals, writes, and commands | Missing. Commands are not logged (Open Problems). |
| Environment disclosure (working directory sent every turn) | Missing. Only opt-in fields would be sent; today the path is always sent. |
| Data exposure (directory listings sent to the endpoint) | Accepted. History is never written to disk. |

## Future Work

- Per-tool argument rules in the grammar, generated from each `ToolSpec`'s parameters, so the server
  rejects bad arguments before `tools::call` sees them.
- Route each tool's arguments through `tools::call` in tests, so the path from raw arguments to
  `Invocation` is tested as one unit.
- Make `ToolSpec`, `bind`, and each `SPEC` visible only inside `tools`.
- Streaming responses, with sanitization applied per chunk.
- Configuration from a file or environment, with overrides for endpoint, model, timeouts, and the
  history and compaction budgets.
- A `/compact` report that shows the summary and how many turns and tokens it replaced.
- Token-aware trimming of old turns, as the fallback when a summary does not fit, in place of dropping the
  oldest turn outright.
- A `/jobs` command that lists background tasks with their command, state, and age, and a way to read a
  task's output from the terminal, so the user can see what is running before approving a stop.
- Deletion and further execution tools, only after logging is implemented.
- A `/profile` form that clears the selection, and a `/profile` listing that shows the selected profile.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn sends the whole conversation, and each tool round in a turn resends it. Cost grows with
  history length.
- Compaction is a full generation over the conversation. It runs only at the budget.
- The REPL blocks on each request, and input typed during a long generation waits in the terminal.
- Replies are read fully before printing. Streaming would reduce latency.
- A directory listing walks the tree synchronously with no entry cap.
- A foreground command blocks the REPL for up to its 30-second wait. Background tasks have no count limit,
  and each keeps up to 100 KB of output, so many long-running tasks use memory in proportion.
- Each request builds a new `ureq` request. One shared agent would reuse connections.
- Grammar-constrained decoding checks each token against the grammar. Measure its cost against an
  unconstrained request before adding per-tool argument rules.
