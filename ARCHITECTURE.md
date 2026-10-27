# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint. This document describes the architecture the project is working
toward. It is a reference, not a changelog.

## Definitions

- **Turn**: one user line, every tool exchange the model performs while answering it, and the final
  assistant reply (or the failure). A successful turn commits all of its messages to the
  conversation together; a failed turn commits none of them.
- **Message**: an enum with one variant per role. `System`, `User`, and `Assistant` carry content;
  `Assistant` also carries the tool calls it requested; `Tool` carries the id of the call it answers.
  A `Tool` message without a call id cannot be constructed.
- **Conversation**: the ordered list of messages sent to the model on every turn. Owned by the REPL
  session, never by the transport. A later turn sees everything an earlier turn saw, including tool
  results, which remain in history for the rest of the session.
- **Context message**: the leading `system` message that describes the host environment (today,
  the working directory). It is gathered once at startup, held by `session` as the first entry of
  the conversation, resent on every turn, and never trimmed.
- **Provider**: a backend that turns a conversation into the messages of one turn, and reports the
  size of the context it can hold. llama.cpp is the only provider today.
- **Prompt tokens**: the prompt token count the provider reports for the final request of a turn. It
  covers the whole conversation as the model saw it, so it is the figure that grows toward the
  context size. It is `None` when the server reports no usage; it is never coerced to zero.
- **Context size**: the number of tokens the configured model can hold in one context, as the
  provider reports it. Resolved once per session, not per command.
- **Compaction**: replacing the older turns of a conversation with a summary the model wrote of them.
  The conversation keeps the context message, the summary as one assistant message without tool calls,
  and the last two turns verbatim. Compaction runs when the user asks (`/compact`) and before a turn
  whose last committed prompt tokens have reached 80% of the context size. A turn that reports
  `ContextFull` is discarded, the conversation is compacted, and the turn is sent once more. Compaction
  never edits the messages of a turn in progress.
- **Tool**: a local capability the model may request by name with JSON arguments. A tool is described
  by plain data (name, description, parameters) and executed by plain Rust code. Tools never see
  HTTP, wire types, or the conversation.
- **Tool call and tool result**: a request from the model to run a tool, and the text the tool
  returns. A tool result is data. It is never treated as an instruction.
- **Write**: a tool call that changes the filesystem (`create_file`, `create_directory`, `edit_file`).
  Each write is shown to the user and runs only if the user approves it. A declined write is reported
  to the model as an error and changes nothing. A turn that has attempted a write is never replayed.
- **Wire type**: a struct that matches the JSON shape of a provider request or response. Wire types
  are typed structs, not untyped JSON values, and never leak into the REPL, the tools, or the
  conversation model.
- **Invariants**
  - A failed turn leaves the conversation exactly as it was before the failed user line. It does not
    undo files the turn already changed; see Write.
  - A successful turn appends its user line, its tool exchanges, and its final reply, in order.
    Nothing is appended partially.
  - A turn is a user message, then zero or more rounds of an assistant message with tool calls
    followed by exactly one `Tool` message per call id, then a final assistant message without tool
    calls. `Turn` rejects any other sequence.
  - A turn performs at most a fixed number of tool rounds. Exceeding the limit fails the turn.
  - A turn fails with `ProviderError::ContextFull` in two cases: the server rejects a request because
    it exceeds the context (its error type is exactly `exceed_context_size_error`), or a tool round's
    reply reports a prompt at the 80% budget, in which case its tools are not run. Any other 400 is
    `ProviderError::Rejected`, which carries the server's message, or the raw body when no message can
    be read. A non-2xx status other than 400 is `ProviderError::Status { status }`. `Transport` is reserved
    for failures to reach the server or read its reply. The REPL then
    compacts the conversation and retries the turn once from the compacted history. The provider never
    rewrites history, so a retry sends less than the request that failed.
  - A turn that has attempted a write is never retried. If the context fills after a write, the turn
    fails with `ProviderError::ContextFullAfterChange`, and the REPL reports it without replaying the
    turn. Overflow before any write is `ContextFull` as above.
  - A summary never appears inside a turn. `Turn::new` accepts no plain assistant message before the
    turn's final reply.
  - A compaction leaves exactly the context message, one summary, and the last two turns, in that
    order. A summary that is empty or whitespace-only is an error, and history is left unchanged.
  - A drop is the fallback when the summary request does not fit. It removes the summary if there is
    one, otherwise the oldest turn, leaves the context message and the remaining turns in order, and
    reports how many messages it removed. Its result is `Compaction::Dropped(n)`, never `Summarized`, and
    the prompt tokens become unknown (`None`) until the next committed turn reports them.
  - A tool that receives a path outside the working directory returns an error to the model and
    reads or writes nothing. A write's path is resolved through `path::confine_new`: `..` may not
    climb above the working directory, and the deepest existing ancestor must canonicalize inside it.
  - A write runs only after the user approves its description. The description is shown in full with
    control characters escaped. Approval is deny by default: only an explicit yes accepts it, and a
    declined write returns an error to the model.
  - Secrets (API keys) are never printed, logged, or included in error text.
  - No function panics on bad input or I/O failure; every fallible step returns a `Result`.
  - The library side (everything except `main`) performs no direct stdin/stdout access.

## Structure

Target layout (current code is a subset):

```
src/
  main.rs            entry point: load config, pick the provider, build session, run REPL, map errors to exit codes
  repl.rs            line loop over generic BufRead/Write; runs slash commands, sends every other line to
                     the provider, writes the reply, commits the turn. It owns the approval prompt for
                     writes (shows the change, reads y/N from the same input, default no)
  commands.rs        Command enum (Compact, Exit, Context, Help) and parse(line) -> Option<Command>; pure, no I/O.
                     One table holds each command's name, variant, and description; parse and the
                     /help listing both read that table, so the listing cannot drift from the parser.
                     Any line that does not parse, including plain "exit", "quit", and unknown slash
                     commands, is not a command
  session.rs         Message, Turn, Conversation: a Turn is appended whole or not at all; the
                     Conversation keeps the prompt tokens of the last committed turn; compaction
                     (the only code that removes committed messages) and the 80% budget check
                     `needs_compaction(context_size)`
  config.rs          Config: endpoint URL, model name, timeouts, API key (from env / .env)
  environment.rs     gathers opt-in host facts as plain data (working directory first)
  provider/
    mod.rs           declares its children and nothing else
    types.rs         trait Provider { fn complete(&self, history: &[Message], input: String,
                     runner: &dyn ToolRunner) -> Result<Turn, ProviderError>;
                     fn context_size(&self) -> Result<u64, ProviderError>;
                     fn summarize(&self, history: &[Message]) -> Result<String, ProviderError> }
    llama_cpp.rs     OpenAI-compatible HTTP implementation, its typed wire structs, serde_json use,
                     the tool-round loop, the /v1/models lookup for the configured model's n_ctx,
                     and decoding of JSON argument values into plain `Value`s
  tools/
    mod.rs           registry only: specs() -> &[ToolSpec]; call(name, values: HashMap<String, Value>)
                     -> Result<Invocation, ToolError>, which finds the named spec, validates the values
                     against it, and builds the Invocation through the spec
    runner.rs        WorkspaceTools: implements ToolRunner by running a typed Invocation, and asking
                     for approval first when `Invocation::writes()` is true
    types.rs         plain data shared by the tools: ToolSpec, Param, ParamType, Value, Invocation,
                     ToolCall, ToolRunner; Arguments, whose only constructor is `validated` and whose
                     accessors are visible to `tools` alone
    list_directory.rs  the list_directory tool
    read_file.rs     the read_file tool: a line range with a 500-line / 100 KB output budget
    path.rs          confines a model-supplied path to the working directory: `confine` for a path
                     that must exist, `confine_new` for a write's path, which may not exist yet
    create_file.rs   the create_file tool: a new file, failing if the path already exists
    create_directory.rs  the create_directory tool: creates missing parents
    edit_file.rs     the edit_file tool: one exact, unique replacement in an existing file
  error.rs           error enums per layer (ProviderError, ToolError, ConfigError, SessionError);
                     Display text answers what/where/why/how-to-fix
```

Dependency direction (arrows mean "may depend on"; no cycles):

```
main -> repl -> session -> environment -> (plain data only)
repl -> commands -> (plain data only)
session -> tools (ToolCall only, plain data; a committed tool exchange records its calls)
repl -> provider (trait) -> session (Message, Turn), tools (ToolRunner), error
main -> config, repl, provider::llama_cpp (the only place a concrete provider is chosen)
provider::llama_cpp -> session (Message, Turn), tools (call, Value, ToolCall, ToolRunner, ToolSpec), error
config -> (plain data only); repl never reads config
tools -> (std and plain data only); tools never import provider or session
```

Rules:
- `provider::llama_cpp` is the only module that knows about HTTP, `ureq`, wire shapes, the endpoint
  URL, or the JSON form of a tool specification or tool call. It converts `ToolSpec` to JSON and
  wire tool calls to `ToolCall` values.
- `session` knows nothing about HTTP, stdin, or JSON.
- `tools` knows nothing about HTTP, the provider, or the conversation, and never parses JSON.
  `provider::llama_cpp` decodes a model's JSON arguments into plain `Value`s (text, integer, or
  `Value::Unsupported` for any other JSON type) and passes them with the tool name to `tools::call`.
  A tool call's arguments are stored as these plain `Value`s. When the provider encodes a call back
  to JSON for a request, `Value::Unsupported` becomes `null`, since the original value is not kept,
  and invalid JSON decodes to no arguments, so the tool reports the missing fields.
  The provider never looks up or compares tool names. `tools::call` (in the registry) finds the named
  `ToolSpec` (`ToolError::UnknownTool` if none), checks each value against its `ParamType`s, and
  returns `ToolError::InvalidArguments` naming the field when a value is missing, extra, unsupported,
  or the wrong type. Only then does it produce an `Invocation`, by calling the `bind` function that
  the same spec carries. Because `Arguments` is created and consumed inside `tools`, a call can never
  be bound with arguments validated against another spec. A tool receives its `Invocation` fields and
  the working directory, and returns text or a `ToolError`. Adding a tool means one new file under
  `tools/` holding its `SPEC` and its `bind` function, one `Invocation` variant, one arm in
  `runner.rs`, one arm in `Invocation::writes` (an exhaustive match with no wildcard arm), and one
  entry in the registry's spec list; `provider` and `session` do not change.
- Approval belongs to the runner, not the provider. The REPL owns the prompt, because it holds stdin
  and stdout. The runner is built with the approver, so `Provider::complete` takes no approval argument,
  and a new tool that writes changes no provider signature.
- Mapping an HTTP status and response body to a `ProviderError` is a pure function, kept apart from the
  `ureq` call, so every status and body shape is tested without a server.
- The provider never names the working directory. The caller passes a `&dyn ToolRunner` (built from
  the working directory in `main`), so tool execution is injected rather than looked up by the
  provider.
- `main` assembles but does not author prompt text. Environment facts are gathered by
  `environment` (plain data out, `Result` on failure), and `session` formats them into the context
  message. `main` never builds `Message` values directly.
- `repl` receives a `&dyn Provider` (or generic `P: Provider`) so it can be tested with a fake.
- Compaction is split by responsibility. `session` decides what is kept and owns the 80% budget. It
  hands the provider a `PromptLimit` (built from the context size, with `is_exceeded(prompt_tokens)`),
  and `complete` and `summarize` take it as an argument. `provider` only writes the summary and reports
  `ContextFull`; it holds no threshold of its own and changes no history. `repl` decides when to compact (before a turn, after `/compact`) and
  retries a turn that reports `ContextFull`. The summary request sends the conversation with no
  tools and a fixed request text that is not committed to history. `session` owns the `Compaction`
  outcome (`Summarized` or `Dropped(n)`) that these operations return, and `repl` only reports it, so a
  notice cannot say "summarized" for a drop.
- Slash commands are never sent to the provider. `commands` parses them; `repl` executes them:
  `/exit` ends the loop, `/context` writes `Conversation::context()` to the output, and `/help` writes
  the listing built from the `commands` table. `repl` never indexes into the conversation's message
  list; `Conversation::context()` is the only accessor for the leading context message. Adding a
  command means one `Command` variant, one entry in the `commands` table (which supplies its parse
  and its help line), and one match arm in `repl`. Help text is never written by hand.
- Dependencies are confined as follows: `dotenvy` and the API-key read live in `config`; `ureq`,
  `serde_json`, and `serde` derive macros for wire types live in `provider::llama_cpp`. No module
  under `tools/` depends on `serde` or `serde_json`.
- `Turn` is built only by the provider's tool loop and its fields are private. Its constructor takes
  the new messages and checks the full shape listed under Invariants: user first, each `Tool` message
  answering a call in the assistant message directly before it, and a final assistant reply without
  tool calls. The provider builds `Message` variants directly; `Turn::new` is where that shape is
  enforced, so no caller needs a separate constructor per role.
- `Conversation` holds the only `Vec<Message>` that is ever committed. Nothing outside `session`
  pushes to it. `Conversation::prompt_tokens()` returns the prompt tokens of the last committed
  turn, and `Conversation::context()` returns the context message; both are the only accessors
  `repl` uses for those values.
- `/context` writes the context message, then `<prompt tokens> / <context size>`. The prompt-token
  figure comes from the conversation and the context size from `Provider::context_size`. A failed
  size lookup is reported on the error stream and does not hide the context message.
- Tool output is returned to the model as text. The REPL never prints tool output.
- Modules stay under the project limits: 100 lines per function, 500 code lines per file,
  10 files per directory. Split a directory into subdirectories before it exceeds 10 files.
- No recursion between modules. Recursion within one module is allowed when its depth is bounded by
  a parameter (for example, a directory walk with a maximum depth). Where two components need each
  other, pass a callback or trait object instead of importing each other.
- No cycles between files either, including a child importing its parent. Types that several
  siblings share live in a leaf module (`error.rs`, `tools/types.rs`) that imports nothing from its
  children. A parent `mod.rs` declares its children and holds the registry, nothing more.

## Potential Problems

- **Unbounded history.** Every turn resends the full conversation. Long sessions will exceed the
  model's context window and fail with a server error. Trimming (oldest turns first, system prompt
  kept) must be enforced in `session` against a token or character budget.
- **Unbounded tool output.** A `list_directory` call at depth 5 can list a dependency or build
  directory with an enormous number of entries. The whole listing is committed to history and resent
  with every later turn, so one oversized result can make the rest of the session fail, not just the
  turn that requested it. `list_directory` needs an entry and byte budget, like `read_file`'s, with a
  visible note to the model when output is truncated.
- **Whole-file reads.** `read_file` calls `fs::read` and splits the entire file into lines before
  applying its budget. Memory and time grow with file size, not with the size of the output, so a
  large file read near its end still costs its full size. Reads must stop at the end line through a
  buffered reader.
- **Unrecoverable long lines.** A line over 100 KB makes every range that starts on it fail with
  "line N is longer than 100 KB". The message does not say that the model cannot read that line in
  any range, so the model has no way to make the error go away. The error must say so and name what
  the model can do instead.
- **Round limit discards work.** When a turn exhausts its tool rounds, all of its work is dropped,
  including the earlier tool results. The error does not say so.
- **No request timeouts.** A stalled server blocks the REPL indefinitely. Connect, send, and
  read timeouts must be configured in `provider::llama_cpp` and surfaced as a `Timeout` error.
- **Stringly error payloads.** `ToolError` and the provider error are enums, but their payloads are
  pre-formatted `String`s. `ToolError::Failed` flattens I/O causes into text, so callers and tests
  cannot match on the cause. Payloads must be structured (for example `Io { path, source }`), and
  the provider's error type must be named `ProviderError` as in Structure.
- **`main` exits 0 on REPL failure.** `main` prints a REPL I/O error and returns normally, so a
  failed stdin or stdout exits with status 0. Structure says `main` maps errors to exit codes.
- **Misleading error for invalid JSON arguments.** `decode` turns invalid JSON into no arguments, so
  the model sees "missing 'path'" when the real cause is that its arguments were not valid JSON. The
  error must name the cause, for example by carrying a `MalformedArguments` variant from the provider.
- **Rewritten history.** The conversation is resent with each call's arguments re-encoded from plain
  values. `Value::Unsupported` becomes `null` and invalid JSON becomes `{}`, so the model sees its own
  past calls differently from what it wrote. The model's arguments string should be kept verbatim
  alongside the decoded values, or the lossy form should be shown to the model as an error.
- **Configuration leaks into `main`.** `main` loads `.env` and reads `LLAMA_API_KEY` itself. The
  Rules place `dotenvy` and the key read in `config`, which does not exist yet.
- **Tool errors live outside `error.rs`.** `ToolError` is defined in `tools/types.rs`, not in the
  per-layer `error.rs` that Structure names. Pick one home and move it there.
- **Provider errors carry raw text.** `ProviderError` lives in `error.rs`, but its `Transport` variant
  boxes an arbitrary error. The Display text of that error can echo a ureq message that includes a
  response body. Each provider should supply its own help text rather than the shared wording.
- **Hard-coded configuration.** Endpoint and model name are constants in source. Changing the
  model requires a rebuild.
- **Single-shot failure mode.** A failed turn is dropped silently from history; the user is not told
  what was retained. Reporting must say which message was discarded.
- **Silent zero token count.** When the response omits `usage`, the provider stores 0 and `/context`
  prints `0 / N` as if the conversation were empty. `drop_oldest_turn` also resets the count to 0.
  The absence must be carried as `None` and shown as unknown, in both places.
- **Model not found is overloaded.** `ProviderError::ModelNotFound` is returned both when the
  configured model is absent from `/v1/models` and when it is listed without `meta.n_ctx`. These are
  different failures with different fixes; they need distinct variants that name the model.
- **Plain HTTP.** The default endpoint is `http://127.0.0.1`, so the bearer token crosses the
  network unencrypted if the endpoint is ever pointed at a remote host.
- **Budget threshold in the provider.** `provider::llama_cpp` imports `over_budget` and decides
  `ContextFull` from it. The threshold belongs to `session`, passed in as a `PromptLimit`.
- **Summary discarded by its own check.** `summarize_messages` returns `ContextFull` when the summary
  request's prompt is at 80%, even though the request succeeded and returned a usable summary. The
  caller then drops the oldest turn instead. The success is discarded for a budget, not a failure.
- **Drop outside the model.** The drop fallback removes history, but the Definitions and Invariants
  describe only the summary. A drop leaves no summary, so the "one summary" rule does not hold after
  it, and no invariant states that a drop must be reported. The invariant above must be the only
  rule, and every compaction path must return a `Compaction` outcome.
- **Non-400 error statuses get the connection hint.** A 5xx or other non-2xx reply is reported as
  `ProviderError::Transport`, whose text says "check that the server is running". The server answered,
  so the hint is wrong for it, and `Transport` is reserved for failures to reach the server or read its
  reply. The `Status` variant in Invariants carries these replies instead.
- **Empty server message.** `bad_request` treats `{"error":{"message":""}}` as a message, so `Rejected`
  carries an empty string and the user sees "the server rejected the request: ;". An empty or
  whitespace-only message must fall back to the raw body, as a missing message does.
- **Repeated compaction.** If the context size is small or the summary is large, the conversation
  can reach 80% on every turn, so each turn pays for a full summary request. The REPL should report
  when a compaction did not free enough space.
- **Summary dropped silently.** The summary is not shown to the user, and an empty summary is
  accepted, so a `/compact` with an empty reply discards the history with no error.
- **Loosened turn shape.** `Turn::new` accepts a plain assistant message directly after the user
  message, and a test (`summary_may_precede_tool_rounds`) requires it. No code path produces such a
  message in a turn: summaries are built by `Conversation::compact`, and the provider's loop emits a
  plain assistant message only as a final reply. The allowance and its test must be removed.
- **Compaction and the session boundary.** `repl` reads `conversation.messages().first()` to print
  the context message. Structure says `Conversation::context()` is the only accessor for it.
- **Failed turns forget their writes.** A turn that writes and then fails (round limit, transport
  error, `ContextFullAfterChange`) commits none of its messages. The files stay changed, the next turn
  does not know they changed, and the user sees only the error. A failed turn must still record the
  writes it applied, and its error must name the changed paths.
- **The write gate is a `matches!` list.** `Invocation::writes` lists its variants with `matches!` and
  no exhaustive match. A new write variant that is left out compiles, runs without approval, and is
  replayed after an overflow. Approval and replay both depend on this one method.
- **Approval shows model output unescaped.** `describe` prints the path, content, and edit text as
  received. Control characters or carriage returns can hide or rewrite what the user is approving.
- **Approval passes through the provider.** `Provider::complete` takes `approve`, so the provider's
  tool loop and trait carry a user prompt. The Structure rules place approval in the runner.
- **Writes are not atomic.** `create_file` creates the file before it writes the content, so a failure
  in between leaves an empty or partial file. `edit_file` rewrites the whole file in place. Both should
  write a temporary file and rename it over the target.
- **Approval and confinement are separate steps.** Approval shows the path, and `confine_new` resolves
  it during the write, so a symlink changed between the two is not shown to the user. `confine_new`
  also uses `Path::exists`, which follows symlinks, so a dangling symlink is skipped as an ancestor.
  Safety then depends on the OS refusing to create through it, and no test pins that.

## Security Concerns

Trust boundaries:
- **Model output** is untrusted. It is printed to the user's terminal and may request tool calls.
  Tool names and arguments are model output, so they are validated like any other input.
- **Tool arguments** are untrusted. A path argument may be absolute, contain `..`, or name a symlink
  that points outside the working directory.
- **Local endpoint** responses are untrusted input for parsing purposes (malformed JSON, unexpected
  shape, oversized bodies).
- **File and directory names** under the working directory are untrusted text. They are written by
  someone other than the user and can contain anything, including instructions to the model.
- **`.env` and environment** hold the API key. The file is git-ignored.
- **User stdin** is trusted for intent but may contain control characters or very large lines.

What untrusted input can reach:
- Model text reaches the terminal. Terminal escape sequences in a reply can rewrite the screen,
  change the title, or hide text.
- Tool calls let model output read the local filesystem. Read access is limited to the working
  directory. Three tools write, and each write needs approval; none deletes or executes anything today.
- Tool results go back to the model. File names in them can carry prompt injection, which can steer
  later tool calls and replies. Because tool exchanges are committed to history, an injected
  instruction keeps influencing every later turn of the session, not only the one that read it.
- Error text from the HTTP layer may echo response bodies, which could contain secrets or
  attacker-controlled text. A 400 body's `error.message` (or raw body) is echoed into the terminal text
  of `ProviderError::Rejected` and must pass through the same sanitization as model replies.

Required controls and status:
- **Terminal output sanitization**: strip or escape control characters from model replies, and from
  the approval prompt's description of a write, before printing. *Missing.*
- **Secret handling**: the API key is never printed, never placed in error values, and never
  logged. *Partially met; the key is only read and sent, but error paths have not been audited.*
- **Transport**: remote endpoints must use HTTPS; a plain-HTTP endpoint must be refused unless it
  resolves to loopback. *Missing.*
- **Input and response size limits**: maximum user line length, maximum response body size, and
  maximum tool output size (entries and bytes). *Missing for user lines and response bodies; tool
  output is limited for `read_file` only.*
- **Path confinement**: every tool path is resolved under the working directory before use, and
  symlinks are never followed into recursion. *Met for `list_directory`, `read_file`, and the write
  tools*: paths are canonicalized, rejected if they fall outside the working directory, and symlinked
  directories are listed but not entered. Writes use `confine_new`, which also refuses a `..` that
  climbs above the working directory. *Missing: the approved description does not record the resolved
  path, so a changed symlink is not caught.*
- **Prompt injection from tool results**: tool output is delivered as clearly labelled tool
  messages, length-limited, and never executed. The model is never given a tool that acts on output
  without confirmation. *Partly met: `read_file` output is length-limited; no output is labelled as
  untrusted data, and `list_directory` is not length-limited.*
- **Tool authorization**: read-only tools may run without confirmation. Any tool that writes requires
  the user's explicit approval for each call, and is deny-by-default. *Approval met; logging missing.*
  Each approval and each write must be logged. Approval answers are read from the same input stream as
  user lines, so queued or piped input can answer a prompt. A deletion or execution tool needs the same
  policy before it is added.
- **Data exposure**: conversation content and tool results are sent only to the configured endpoint.
  Directory names from the working directory therefore reach that endpoint. The client never writes
  history to disk unless that is added deliberately with a documented location and permissions.
  *Met today for history; directory listings are sent unconditionally.*
- **Environment disclosure**: the context message sends the working directory path (which can
  include the OS user name and project layout) to the configured endpoint on every turn. Controls:
  only fields the user has opted into are included, the home-directory prefix is shortened, and the
  context is shown to the user at startup. *Missing; the path is sent unconditionally today.*
- **Model-written summaries**: a compaction summary is model output that becomes an assistant message
  in history and is sent on every later turn. Injected text in the summarized history can therefore
  persist through a compaction, just as tool results persist. The summary is data, never an
  instruction, and it is never printed as a control sequence. The summary request uses no tools, so
  it cannot cause tool execution. *Partly met: no tools are offered, but the summary is not labelled
  as untrusted and is not shown to the user for review.*
- **Unauthenticated state changes**: file writes are the only state change, and each needs the user's
  approval in the session. *Missing: a record of applied writes that survives a failed turn, since such
  a turn commits no messages.* Any future persistence or execution must also require the user's own
  action in the session.

## Future Work

- `ToolSpec`, its fields including `bind`, and each tool's `SPEC` become visible only inside `tools`.
  Outside `tools`, the only reachable items are the registry functions, `ToolRunner`, and the plain
  data types, so no other module can construct a spec or call a `bind` function directly.
- Each tool's `bind` is covered by tests that go through `tools::call`, so the path from raw
  arguments to `Invocation` is tested as one unit rather than through `Arguments::validated` alone.
- Structured error enums per layer (`ProviderError`, `ToolError`, `ConfigError`, `SessionError`)
  in `error.rs`, with actionable messages.
- Output budget and truncation notice for every tool, with the same line and byte limits as
  `read_file`, and a labelled, untrusted-data wrapper around all tool results.
- `read_file` streams lines through a buffered reader and stops at its budget or the end line.
- Configuration loaded from a file or environment with overrides for endpoint, model, timeouts,
  and history budget.
- Tests for the body classification described under Invariants, covering a 400 whose message is empty or
  whitespace-only (the raw body is kept in `Rejected`), and a non-400 error status mapped to `Status`.
- Token-aware history trimming that keeps the context message and the most recent turns, used as the
  deterministic fallback when a summary request does not fit.
- Compaction budget set from configuration, and a `/compact` report that shows the user the summary
  it replaced the history with, with the number of turns and tokens it removed.
- A turn that has written is never retried. A later turn should still learn what the failed turn
  changed, through a record of applied writes that is committed even when the turn fails.
- Streaming responses, with the same sanitization applied per chunk.
- Deletion and execution tools only after the logging policy above is implemented. Writes already
  require confirmation; logging is still missing.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn serializes and sends the entire conversation. Cost grows linearly with history length
  per turn, and quadratically over a session.
- Each tool round resends the whole conversation, so a turn with N tool rounds costs about N times a
  turn without tools.
- A directory listing walks the tree synchronously on the REPL thread. Depth 5 over a large tree is
  unbounded in entries and time; a walk needs an entry cap.
- `read_file` reads the whole file into memory and splits every line before its budget applies. A
  buffered reader that stops at the end line bounds both memory and time by the requested range.
- Responses are read fully into memory before printing. Streaming would reduce perceived latency.
- The REPL blocks on each request; input typed during a long generation is queued by the terminal,
  not processed.
- The current code builds a new `ureq` request per call through the free `ureq::post` function.
  The provider should hold one agent for connection reuse across turns.
- Each compaction is a full generation over the whole conversation, so compacting is as slow as a
  long turn. Compaction should run only when the budget is reached, never on every turn.
- Each `/context` and each turn asks for the context size. The size is fixed for a session, so it is
  resolved once and a failure is retried on the next request. Only the first lookup touches the network.
