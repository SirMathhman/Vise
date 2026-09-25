# Vise — Architecture

## Definitions

- **REPL** — the interactive read-eval-print loop. The only user-facing entry point.
- **Evaluator** — an object that owns conversation state (a growing `Vec<Msg>`) and, per turn, sends the full history to the LLM and appends the reply. Stateless HTTP calls are the _mechanism_; the Evaluator is the _state machine_.
- **EvalError** — a structured, non-panicking error enum that answers: what went wrong, why, and how to fix it. Must distinguish transport failure (no server, DNS) from application failure (401, 404, 500) from decode failure (valid HTTP, wrong JSON shape).
- **Command** — a user-typed line that is not sent to the model (`/exit`, `/clear`, `/help`). Intercepted by the REPL, not the Evaluator.
- **Turn** — one user line + one model reply. The unit of history.

## Structure

```
vise/
├── src/
│   ├── main.rs       // Entry point: owns Client + Evaluator, REPL loop
│   ├── evaluator.rs  // Evaluator state machine: owns history Vec<(role, content)>, parses tool calls (ToolCall, extract_tool), fn eval(&mut self) -> Result<String, EvalError>
│   ├── tools.rs      // Tool I/O + result types: DirListing/DirEntry/EntryKind/FileContent, read_dir/read_file, format_listing/format_file
│   ├── client.rs     // reqwest Client consts (BASE_URL, API_KEY, MODEL); typed request/response structs
│   └── error.rs      // EvalError enum + Display impl
```

**Dependency direction:** `main → evaluator → {tools, client, error}`. No upward or circular dependencies.
`client` is a leaf that knows only about the llama.cpp HTTP API. `tools` owns filesystem I/O and the result types for each tool. `evaluator` is the state machine (no filesystem I/O — it delegates to `tools`). `main` owns the REPL loop, wires everything together, and declares the modules.

### Crate layout (when the binary outgrows ~500 lines)

```
vise/
├── Cargo.toml       // workspace
├── vise-core/       // evaluator, client, error — no terminal I/O, no `main`
├── vise-repl/       // depends on vise-core; owns the prompt loop
└── vise-bin/        // depends on both; `fn main` is ~10 lines
```

`vise-core` is the unit under test: `Evaluator` + `LlmClient` can be exercised against a mock server without a terminal.

## Tools

- **`read_dir`** — lets the agent inspect a directory's contents. The system message tells the model it may emit `read_dir("<path>")` in its reply. `Evaluator::eval` loops over turns: it sends a request, and if the reply contains a tool call, it executes it via `tools.rs`, feeds the result back as the next user message, and asks the model again — until the model gives a final answer.
- **`read_file`** — lets the agent read a file's contents. Same loop: the model emits `read_file("<path>")`, the REPL reads the file (capped, see below) and feeds it back.
- **Detection** — `extract_tool` scans the reply for the first `read_dir(` or `read_file(` marker and pulls out the quoted path, dispatching to the matching handler. Both tools share the same text protocol; no extra schema or dependencies.
- **Path resolution** — the argument is relative to the CWD (the same value injected into the system message), resolved via `base.join(path)`.
- **Arbitrarily sized** — `read_dir` streams through `std::fs::read_dir` and stops at `MAX_LISTING_ENTRIES`; `read_file` reads at most `MAX_FILE_BYTES` (32 KiB) into a single buffer. A huge directory or file never materializes more than the cap in memory or overflows the model's context; the result is marked `truncated` and the model is told so in the header.

## Commands

- **`/exit`** — exits the REPL (also exits on EOF).
- **`/context`** — prints the current context usage as `Context: <used> / <total> tokens`. `used` is an estimate of the tokens in the system prompt plus all history (`chars / 4`); `total` is `CONTEXT_WINDOW` from `client.rs`. It is a rough estimate, not an exact token count, and does not require a model call.

## Potential Problems

- **API key in source** — `const API_KEY` will become a git secret. Must move to environment variable or CLI flag before any non-local deployment.
- **Unbounded history** — `history: Vec<(String, String)>` grows without limit. Will eventually exceed context window. A sliding window or summary-based truncation will be needed; profile real usage before choosing a strategy.
- **Multi-line input** — `read_line` gives one line per turn. Block expressions or multi-line prompts will need a continuation prompt or a line editor (`rustyline`). Not a problem until someone needs it.
- **Blocking client in an async world** — `reqwest::blocking` is fine for a CLI REPL. If the project later adds concurrent features (e.g., streaming tokens, multiple servers), migrate to `tokio` + async `reqwest`. Do not do this preemptively.
- **No streaming** — responses are buffered. For long completions the user sees a blank prompt for the entire inference time. Streaming (`SSE` / `stream: true`) is the natural next feature but adds significant complexity; only add when the UX cost is real.

## Future Work

- Move `API_KEY` to `std::env::var("VISE_API_KEY")` with a compile-time default for local dev.
- Add `/clear` command to reset `Evaluator` history without restarting.
- Add integration tests in `vise-core` against a mock HTTP server (`wiremock` or a local `llama-server`) — these need no terminal.
- Consider streaming responses (`stream: true`) when the blocking UX cost becomes real.
- Add history truncation strategy (sliding window or summary) before context window is hit in practice.

## Performance

- **Inference latency** — dominated by the model, not the client. The client adds < 1 ms. Nothing to optimize until the model is local and fast.
- **History growth** — unbounded `Vec<Msg>` will eventually exceed context window. A sliding window or summary-based truncation will be needed; profile real usage before choosing a strategy.
- **Buffering** — `read_line` on `stdin` is fine. No need for `BufReader` in a one-line-at-a-time REPL.
