# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server that exposes an OpenAI-compatible
`/v1/chat/completions` endpoint. This document describes the architecture the project is working
toward. It is a reference, not a changelog.

## Definitions

- **Turn**: one user line, the request it produces, and the assistant reply (or the failure).
- **Conversation**: the ordered list of messages (`system`, `user`, `assistant`) sent to the model
  on every turn. Owned by the REPL session, never by the transport.
- **Provider**: a backend that turns a conversation into a reply. llama.cpp is the only provider today.
- **Wire type**: a struct that matches the JSON shape of a provider request or response. Wire types
  never leak into the REPL or the conversation model.
- **Invariants**
  - A failed turn leaves the conversation exactly as it was before the failed user line.
  - Secrets (API keys) are never printed, logged, or included in error text.
  - No function panics on bad input or I/O failure; every fallible step returns a `Result`.
  - The library side (everything except `main`) performs no direct stdin/stdout access.

## Structure

Target layout (current code is a subset):

```
src/
  main.rs           entry point: load config, build session, run REPL, map errors to exit codes
  repl.rs           line loop, command parsing ("exit", "quit"), printing
  session.rs        Conversation state: append, rollback on failure, trimming to a budget
  config.rs         Config: endpoint URL, model name, timeouts, API key (from env / .env)
  provider/
    mod.rs          trait Provider { fn complete(&self, &Conversation) -> Result<Reply, ProviderError> }
    llama_cpp.rs    OpenAI-compatible HTTP implementation (wire types live here)
  error.rs          error enums per layer; Display text answers what/where/why/how-to-fix
```

Dependency direction (arrows mean "may depend on"; no cycles):

```
main -> repl -> session -> (plain data only)
repl -> provider (trait) -> error
main -> config, repl, provider::llama_cpp (the only place a concrete provider is chosen)
config -> (plain data only); repl never reads config
```

Rules:
- `provider::llama_cpp` is the only module that knows about HTTP, `ureq`, `serde` wire shapes, or
  the endpoint URL.
- `session` knows nothing about HTTP or stdin.
- `repl` receives a `&dyn Provider` (or generic `P: Provider`) so it can be tested with a fake.
- Dependencies (`dotenvy`, `serde`, `serde_json`, `ureq`) are confined to the modules above; no
  other module imports them.
- Modules stay under the project limits: 100 lines per function, 500 code lines per file,
  10 files per directory. Split a directory into subdirectories before it exceeds 10 files.
- No recursion between modules. Where two components need each other, pass a callback or trait
  object instead of importing each other.

## Potential Problems

- **Unbounded history.** Every turn resends the full conversation. Long sessions will exceed the
  model's context window and fail with a server error. Trimming (oldest turns first, system prompt
  kept) must be enforced in `session` against a token or character budget.
- **No request timeouts.** A stalled server blocks the REPL indefinitely. Connect, send, and
  read timeouts must be configured in `provider::llama_cpp` and surfaced as a `Timeout` error.
- **Stringly errors.** Errors currently flow as `Box<dyn Error>` and ad-hoc strings. This hides
  the cause from callers and from tests.
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
- **Model output** is untrusted. It is printed to the user's terminal and, in future, may request
  tool calls.
- **Local endpoint** responses are untrusted input for parsing purposes (malformed JSON, unexpected
  shape, oversized bodies).
- **`.env` and environment** hold the API key. The file is git-ignored.
- **User stdin** is trusted for intent but may contain control characters or very large lines.

What untrusted input can reach:
- Model text reaches the terminal. Terminal escape sequences in a reply can rewrite the screen,
  change the title, or hide text.
- If tool use is added, model output can trigger actions on the user's behalf. Prompt injection
  from any text the model reads (files, web pages, tool results) can steer those actions.
- Error text from the HTTP layer may echo response bodies, which could contain secrets or
  attacker-controlled text.

Required controls and status:
- **Terminal output sanitization**: strip or escape control characters from model replies before
  printing. *Missing.*
- **Secret handling**: the API key is never printed, never placed in error values, and never
  logged. *Partially met; the key is only read and sent, but error paths have not been audited.*
- **Transport**: remote endpoints must use HTTPS; a plain-HTTP endpoint must be refused unless it
  resolves to loopback. *Missing.*
- **Input and response size limits**: maximum user line length and maximum response body size.
  *Missing.*
- **Prompt injection and tool authorization**: before any tool call exists, the design requires an
  explicit confirmation step for side-effecting tools and a deny-by-default policy. *Not yet
  applicable; must be designed before tools are added.*
- **Data exposure**: conversation content is sent only to the configured endpoint. The client never
  writes history to disk unless that is added deliberately with a documented location and
  permissions. *Met today.*
- **Unauthenticated state changes**: none today. Any future persistence or tool execution must
  require the user's own action in the session.

## Future Work

- Introduce `Provider` trait and move HTTP code behind it; keep `repl` and `session` free of `ureq`.
- Structured error enums per layer (`ProviderError`, `ConfigError`, `SessionError`) with
  actionable messages.
- Configuration loaded from a file or environment with overrides for endpoint, model, timeouts,
  and history budget.
- Token-aware history trimming that keeps the system prompt and the most recent turns.
- Unit tests with a fake `Provider` for REPL behavior (rollback on failure, exit words, empty lines).
- Streaming responses, with the same sanitization applied per chunk.
- Optional tool-calling layer with explicit, logged user confirmation.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn serializes and sends the entire conversation. Cost grows linearly with history length
  per turn, and quadratically over a session.
- Responses are read fully into memory before printing. Streaming would reduce perceived latency.
- The REPL blocks on each request; input typed during a long generation is queued by the terminal,
  not processed.
- The current code builds a new `ureq` request per call through the free `ureq::post` function.
  The provider should hold one agent for connection reuse across turns.
