# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint. This document describes the architecture the project is working
toward. It is a reference, not a changelog.

## Definitions

- **Turn**: one user line, every tool exchange the model performs while answering it, and the final
  assistant reply (or the failure). A successful turn commits all of its messages to the
  conversation together; a failed turn commits none of them.
- **Conversation**: the ordered list of messages (`system`, `user`, `assistant`, `tool`) sent to the
  model on every turn. Owned by the REPL session, never by the transport. An assistant message that
  requests tools keeps those tool calls, and each tool result is a `tool` message tied to its call
  id, so a later turn sees everything an earlier turn saw.
- **Context message**: the leading `system` message that describes the host environment (today,
  the working directory). It is gathered once at startup, held by `session` as the first entry of
  the conversation, resent on every turn, and never trimmed.
- **Provider**: a backend that turns a conversation into the messages of one turn. llama.cpp is the
  only provider today.
- **Tool**: a local capability the model may request by name with JSON arguments. A tool is described
  by plain data (name, description, parameters) and executed by plain Rust code. Tools never see
  HTTP, wire types, or the conversation.
- **Tool call and tool result**: a request from the model to run a tool, and the text the tool
  returns. A tool result is data. It is never treated as an instruction.
- **Wire type**: a struct that matches the JSON shape of a provider request or response. Wire types
  are typed structs, not untyped JSON values, and never leak into the REPL, the tools, or the
  conversation model.
- **Invariants**
  - A failed turn leaves the conversation exactly as it was before the failed user line.
  - A successful turn appends its user line, its tool exchanges, and its final reply, in order.
    Nothing is appended partially.
  - A turn performs at most a fixed number of tool rounds. Exceeding the limit fails the turn.
  - A tool that receives a path outside the working directory returns an error to the model and
    reads nothing.
  - Secrets (API keys) are never printed, logged, or included in error text.
  - No function panics on bad input or I/O failure; every fallible step returns a `Result`.
  - The library side (everything except `main`) performs no direct stdin/stdout access.

## Structure

Target layout (current code is a subset):

```
src/
  main.rs            entry point: load config, build session, run REPL, map errors to exit codes
  repl.rs            line loop, command parsing ("exit", "quit"), printing
  session.rs         Conversation state: commit a turn atomically, rollback on failure, trimming
  config.rs          Config: endpoint URL, model name, timeouts, API key (from env / .env)
  environment.rs     gathers opt-in host facts as plain data (working directory first)
  provider/
    mod.rs           trait Provider { fn complete(&self, &Conversation) -> Result<Turn, ProviderError> }
                     Turn holds the messages to append on success
    llama_cpp.rs     OpenAI-compatible HTTP implementation, its typed wire structs, and the
                     tool-round loop
  tools/
    mod.rs           registry: specs() -> Vec<ToolSpec>; execute(ToolCall) -> Result<String, ToolError>
    list_directory.rs  the list_directory tool and its argument struct
    path.rs          confines a model-supplied path to the working directory
  error.rs           error enums per layer; Display text answers what/where/why/how-to-fix
```

Dependency direction (arrows mean "may depend on"; no cycles):

```
main -> repl -> session -> environment -> (plain data only)
session -> tools (ToolCall only, plain data; a committed tool exchange records its calls)
repl -> provider (trait) -> error
main -> config, repl, provider::llama_cpp (the only place a concrete provider is chosen)
provider::llama_cpp -> tools (ToolSpec, ToolCall, execute) -> error
config -> (plain data only); repl never reads config
tools -> (std and plain data only); tools never import provider or session
```

Rules:
- `provider::llama_cpp` is the only module that knows about HTTP, `ureq`, wire shapes, the endpoint
  URL, or the JSON form of a tool specification or tool call. It converts `ToolSpec` to JSON and
  wire tool calls to `ToolCall` values.
- `session` knows nothing about HTTP, stdin, or JSON.
- `tools` knows nothing about HTTP, the provider, or the conversation. A tool receives a typed
  argument struct and the working directory, and returns text or a `ToolError`. Adding a tool means
  one new file under `tools/` and one entry in the registry; `provider` and `session` do not change.
- `main` assembles but does not author prompt text. Environment facts are gathered by
  `environment` (plain data out, `Result` on failure), and `session` formats them into the context
  message. `main` never builds `Message` values directly.
- `repl` receives a `&dyn Provider` (or generic `P: Provider`) so it can be tested with a fake.
- Dependencies are confined as follows: `dotenvy` and the API-key read live in `config`; `ureq` lives
  in `provider::llama_cpp`; `serde_json` lives in `provider::llama_cpp`. `serde` may also be used in
  `tools`, but only to decode a tool's own argument struct. That is the single exception to serde
  confinement.
- Tool output is returned to the model as text. The REPL never prints tool output.
- Modules stay under the project limits: 100 lines per function, 500 code lines per file,
  10 files per directory. Split a directory into subdirectories before it exceeds 10 files.
- No recursion between modules. Recursion within one module is allowed when its depth is bounded by
  a parameter (for example, a directory walk with a maximum depth). Where two components need each
  other, pass a callback or trait object instead of importing each other.

## Potential Problems

- **Unbounded history.** Every turn resends the full conversation. Long sessions will exceed the
  model's context window and fail with a server error. Trimming (oldest turns first, system prompt
  kept) must be enforced in `session` against a token or character budget.
- **Tool exchanges are discarded.** The current loop keeps tool calls and results only for the turn
  that produced them. On a later turn the model cannot see what a tool returned, and its reply may
  refer to output it no longer has. Tool exchanges must be committed with the turn (see Definitions).
- **Unbounded tool output.** A `list_directory` call at depth 5 can list a dependency or build
  directory with an enormous number of entries. The whole listing is sent to the model in one
  message and can exceed the context window. Tool output needs an entry and byte budget, with a
  visible note to the model when output is truncated.
- **Round limit discards work.** When a turn exhausts its tool rounds, all of its work is dropped,
  including the earlier tool results. The error does not say so.
- **No request timeouts.** A stalled server blocks the REPL indefinitely. Connect, send, and
  read timeouts must be configured in `provider::llama_cpp` and surfaced as a `Timeout` error.
- **Stringly error payloads.** `ToolError` and the provider error are enums, but their payloads are
  pre-formatted `String`s. `ToolError::Failed` flattens I/O causes into text, so callers and tests
  cannot match on the cause. Payloads must be structured (for example `Io { path, source }`), and
  the provider's error type must be named `ProviderError` as in Structure.
- **Panics in I/O.** Reading stdin uses `expect`, which aborts the process on a read failure
  instead of reporting it.
- **Hard-coded configuration.** Endpoint and model name are constants in source. Changing the
  model requires a rebuild.
- **Single-shot failure mode.** A failed turn is dropped silently from history; the user is not told
  what was retained. Reporting must say which message was discarded.
- **Plain HTTP.** The default endpoint is `http://127.0.0.1`, so the bearer token crosses the
  network unencrypted if the endpoint is ever pointed at a remote host.

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
  directory; no tool writes, deletes, or executes anything today.
- Tool results go back to the model. File names in them can carry prompt injection, which can steer
  later tool calls and replies.
- Error text from the HTTP layer may echo response bodies, which could contain secrets or
  attacker-controlled text.

Required controls and status:
- **Terminal output sanitization**: strip or escape control characters from model replies before
  printing. *Missing.*
- **Secret handling**: the API key is never printed, never placed in error values, and never
  logged. *Partially met; the key is only read and sent, but error paths have not been audited.*
- **Transport**: remote endpoints must use HTTPS; a plain-HTTP endpoint must be refused unless it
  resolves to loopback. *Missing.*
- **Input and response size limits**: maximum user line length, maximum response body size, and
  maximum tool output size (entries and bytes). *Missing for all three.*
- **Path confinement**: every tool path is resolved under the working directory before use, and
  symlinks are never followed into recursion. *Met for `list_directory`*: paths are canonicalized,
  rejected if they fall outside the working directory, and symlinked directories are listed but not
  entered.
- **Prompt injection from tool results**: tool output is delivered as clearly labelled tool
  messages, length-limited, and never executed. The model is never given a tool that acts on output
  without confirmation. *Missing: output is not length-limited or labelled as untrusted data.*
- **Tool authorization**: read-only tools may run without confirmation. Any side-effecting tool
  requires explicit, logged user confirmation and is deny-by-default. *Not applicable yet, because no
  side-effecting tool exists; the policy must be implemented before one is added.*
- **Data exposure**: conversation content and tool results are sent only to the configured endpoint.
  Directory names from the working directory therefore reach that endpoint. The client never writes
  history to disk unless that is added deliberately with a documented location and permissions.
  *Met today for history; directory listings are sent unconditionally.*
- **Environment disclosure**: the context message sends the working directory path (which can
  include the OS user name and project layout) to the configured endpoint on every turn. Controls:
  only fields the user has opted into are included, the home-directory prefix is shortened, and the
  context is shown to the user at startup. *Missing; the path is sent unconditionally today.*
- **Unauthenticated state changes**: none today. Any future persistence or side-effecting tool
  execution must require the user's own action in the session.

## Future Work

- Introduce `Provider` trait and move HTTP code behind it; keep `repl` and `session` free of `ureq`.
- Structured error enums per layer (`ProviderError`, `ToolError`, `ConfigError`, `SessionError`)
  with actionable messages.
- Tool-exchange commit: a turn returns its messages as a `Turn`, and `session` appends them
  atomically.
- Output budget and truncation notice for tool results.
- Configuration loaded from a file or environment with overrides for endpoint, model, timeouts,
  and history budget.
- Token-aware history trimming that keeps the context message and the most recent turns.
- Unit tests with a fake `Provider` for REPL behavior (rollback on failure, exit words, empty lines).
- Streaming responses, with the same sanitization applied per chunk.
- Side-effecting tools only after the confirmation and logging policy above is implemented.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn serializes and sends the entire conversation. Cost grows linearly with history length
  per turn, and quadratically over a session.
- Each tool round resends the whole conversation, so a turn with N tool rounds costs about N times a
  turn without tools.
- A directory listing walks the tree synchronously on the REPL thread. Depth 5 over a large tree is
  unbounded in entries and time; a walk needs an entry cap.
- Responses are read fully into memory before printing. Streaming would reduce perceived latency.
- The REPL blocks on each request; input typed during a long generation is queued by the terminal,
  not processed.
- The current code builds a new `ureq` request per call through the free `ureq::post` function.
  The provider should hold one agent for connection reuse across turns.
