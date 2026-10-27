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
- **Write**: a tool call that changes the filesystem or runs a program (`create_file`,
  `create_directory`, `edit_file`, `run_powershell`). A write runs only after the user approves it. A
  declined write is reported to the model as an error and changes nothing.
- **Wire type**: a struct matching the JSON shape of a provider request or response. Wire types never
  leave `provider::llama_cpp`.

## Invariants

- A successful turn appends its user line, its tool exchanges, and its reply together. A failed turn
  leaves the conversation as it was. It does not undo files the turn changed (see Open Problems).
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
  gate, and it shows the command in full. A command past its time limit is stopped together with every
  process it started, and the reply says it was stopped. Its output is bounded while it is read.
- A write runs only after the user approves a description of it. The default is no: only `y` or `yes`
  approves.
- Slash commands (`/compact`, `/context`, `/exit`, `/help`) are never sent to the model. Every other line
  is, including `exit`, `quit`, and unknown slash commands.
- API keys are never printed, logged, or put in error text.
- No function panics on bad input or failed I/O; fallible steps return `Result`.

## Structure

```
src/
  main.rs            wiring: reads .env and LLAMA_API_KEY, takes the working directory, builds the
                     provider and tool runner, runs the REPL. Fatal startup errors go to exit_with.
  repl.rs            the input loop over generic BufRead/Write. Parses and runs slash commands,
                     decides when to compact, retries a turn that reports ContextFull once, asks
                     for approval of writes, and writes replies and notices
  session.rs         Message, Turn (checked shape), Conversation (committed history, prompt tokens of
                     the last committed turn, compaction, drop_oldest_turn), over_budget (80%)
  environment.rs     gathers host facts as plain data (working directory)
  error.rs           ProviderError, SessionError, MAX_TOOL_ROUNDS
  provider/
    mod.rs           declarations only
    types.rs         trait Provider: complete, context_size, summarize
    llama_cpp.rs     the HTTP client; wire structs; the tool-round loop; the 400 mapping
                     (bad_request); the /v1/models lookup; conversion between JSON arguments and Values
  tools/
    mod.rs           registry: specs(), call(name, values) -> Invocation
    types.rs         ToolSpec, Param, ParamType, Value, Arguments, Invocation, ToolCall, ToolError,
                     ToolRunner
    runner.rs        WorkspaceTools: runs an Invocation, asks for approval first when it writes
    path.rs          confine (existing paths) and confine_new (paths a write creates)
    list_directory.rs  recursive listing to a depth of 1 to 5
    read_file.rs     a 1-based line range, capped at 500 lines or 100 KB
    create_file.rs   a new file; fails if the path exists
    create_directory.rs  creates missing parents; succeeds if the directory exists
    edit_file.rs     one exact, unique replacement in an existing file
    run_powershell.rs  runs one Windows PowerShell command in the working directory, stopped after
                     30 seconds, with output capped at 100 KB
```

Dependencies (an arrow means "may depend on"; there are no cycles):

```
main -> repl, session, provider::llama_cpp, tools::runner, environment, error
repl -> provider::types, session, tools::types, error
provider -> session (Message, Turn, over_budget), tools (registry and types), error
session -> environment, tools::types (ToolCall only)
tools -> tools' own types, std (no provider, session, HTTP, or serde)
```

## Rules

- `provider::llama_cpp` is the only module that knows HTTP, `ureq`, the endpoint, the wire shapes, or
  the JSON form of tool specs and calls.
- `tools` never parses JSON and never imports the provider or the session. The provider decodes a
  model's arguments into plain `Value`s (text, integer, or `Unsupported`) and passes them with the tool
  name to `tools::call`. `call` finds the spec, checks the values against its parameter types, and calls
  the spec's own `bind` function. The provider never compares tool names.
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
- **Failed turns forget their writes.** A turn that writes and then fails (round limit, transport error,
  `ContextFullAfterChange`) commits none of its messages. The files stay changed, the next turn does not
  know it, and the user sees only the error. A failed turn must record the writes it applied, and its
  error must name the changed paths.
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
- **A stopped command can leave processes running.** The time limit kills only `powershell.exe`. A process
  the command started keeps running with the user's permissions after the tool reports the command as
  stopped. The stop must end the whole process tree; on Windows, a job object that kills its members when
  it closes.
- **Output is held in memory before it is capped.** Both pipes are read to the end, and the 100 KB limit is
  applied afterwards, so a command that writes a large amount within its time limit uses that memory. Reads
  must stop at the cap and discard the rest.
- **Commands are not logged.** Every approval, write, and command must be recorded before it runs, with
  its text, working directory, approval, and exit status. `run_powershell` records nothing. Deletion and
  further execution tools wait for this.
- **The command runs only on Windows.** `run_powershell` starts `powershell.exe` with no platform split.
  The process handling belongs behind one module boundary, with the Windows implementation behind it, so
  another platform adds an implementation rather than branches.

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
| Size limits on user lines and response bodies | Missing. |
| Size limits on tool output | `read_file` and `run_powershell` (the latter after reading; see Open Problems). `list_directory` has none. |
| Limits on commands: time, process tree, output | Partly met. The time limit and output cap exist; the process tree is not stopped (Open Problems). |
| Tool results and summaries marked as untrusted data | Missing. |
| Logging of approvals, writes, and commands | Missing. Commands are not logged (Open Problems). |
| Environment disclosure (working directory sent every turn) | Missing. Only opt-in fields would be sent; today the path is always sent. |
| Data exposure (directory listings sent to the endpoint) | Accepted. History is never written to disk. |

## Future Work

- Route each tool's arguments through `tools::call` in tests, so the path from raw arguments to
  `Invocation` is tested as one unit.
- Make `ToolSpec`, `bind`, and each `SPEC` visible only inside `tools`.
- Streaming responses, with sanitization applied per chunk.
- Configuration from a file or environment, with overrides for endpoint, model, timeouts, and the
  history and compaction budgets.
- A `/compact` report that shows the summary and how many turns and tokens it replaced.
- Token-aware trimming of old turns, as the fallback when a summary does not fit, in place of dropping the
  oldest turn outright.
- Deletion and further execution tools, only after logging is implemented.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn sends the whole conversation, and each tool round in a turn resends it. Cost grows with
  history length.
- Compaction is a full generation over the conversation. It runs only at the budget.
- The REPL blocks on each request, and input typed during a long generation waits in the terminal.
- Replies are read fully before printing. Streaming would reduce latency.
- A directory listing walks the tree synchronously with no entry cap.
- A command blocks the REPL for up to its time limit, and its output is buffered before the cap applies.
- Each request builds a new `ureq` request. One shared agent would reuse connections.
