# Vise — Architecture

## Definitions

- **REPL** — the interactive read-eval-print loop. The only user-facing entry point.
- **Evaluator** — an object that owns conversation state (a growing `Vec<Msg>`) and, per turn, sends the full history to the LLM and appends the reply. Stateless HTTP calls are the *mechanism*; the Evaluator is the *state machine*.
- **EvalError** — a structured, non-panicking error enum that answers: what went wrong, why, and how to fix it. Must distinguish transport failure (no server, DNS) from application failure (401, 404, 500) from decode failure (valid HTTP, wrong JSON shape).
- **Command** — a user-typed line that is not sent to the model (`/exit`, `/clear`, `/help`). Intercepted by the REPL, not the Evaluator.
- **Turn** — one user line + one model reply. The unit of history.

## Structure

```
vise/
├── src/
│   ├── main.rs       // Thin entry point: arg/env parsing, owns Client + Evaluator, REPL loop
│   ├── repl.rs       // Prompt loop, line reading, command dispatch, empty-line skip
│   ├── evaluator.rs  // Evaluator struct: owns Vec<Msg>, fn eval(&mut self) -> Result<String, EvalError>
│   ├── client.rs     // LlmClient: wraps reqwest::blocking::Client, BASE_URL, API_KEY; typed request/response structs
│   └── error.rs      // EvalError enum + Display impl
```

**Dependency direction:** `main → repl → evaluator → client → error`. No upward or circular dependencies.
`client` is a leaf that knows only about the llama.cpp HTTP API. `evaluator` is pure logic (no I/O beyond calling `client`). `repl` owns the loop but delegates evaluation. `main` wires everything together.

### Crate layout (when the binary outgrows ~500 lines)

```
vise/
├── Cargo.toml       // workspace
├── vise-core/       // evaluator, client, error — no terminal I/O, no `main`
├── vise-repl/       // depends on vise-core; owns the prompt loop
└── vise-bin/        // depends on both; `fn main` is ~10 lines
```

`vise-core` is the unit under test: `Evaluator` + `LlmClient` can be exercised against a mock server without a terminal.

## Potential Problems

- **Stateless history (current bug)** — every `eval` call sends a single 1-message request. The user cannot reference prior turns. Must be fixed before adding any feature.
- **Error conflation** — `reqwest::Error` from `.send()` and `.json()` are currently both flattened into `EvalError`, and the `reqwest::Error` from a non-2xx `.json()` call is discarded, so 401/404/500 all look identical. The `EvalError` enum must have a `Response { status, body }` variant checked *before* deserialization.
- **API key in source** — `const API_KEY` will become a git secret. Must move to environment variable or CLI flag before any non-local deployment.
- **Multi-line input** — `read_line` gives one line per turn. Block expressions or multi-line prompts will need a continuation prompt or a line editor (`rustyline`). Not a problem until someone needs it.
- **Blocking client in an async world** — `reqwest::blocking` is fine for a CLI REPL. If the project later adds concurrent features (e.g., streaming tokens, multiple servers), migrate to `tokio` + async `reqwest`. Do not do this preemptively.
- **No streaming** — responses are buffered. For long completions the user sees a blank prompt for the entire inference time. Streaming (`SSE` / `stream: true`) is the natural next feature but adds significant complexity; only add when the UX cost is real.

## Future Work

- Add `Evaluator` struct with `history: Vec<Msg>`; change `eval` to take `&mut self` and append both user and assistant turns.
- Add `EvalError::Response { status: u16, body: String }` variant; check `resp.status()` before `.json()`.
- Implement `Display` for `EvalError`; print `{e}` not `{e:?}` in the REPL.
- Skip empty input in the REPL loop.
- Move `API_KEY` to `std::env::var("VISE_API_KEY")` with a compile-time default for local dev.
- Extract `repl.rs` / `evaluator.rs` / `client.rs` / `error.rs` from `main.rs` once the file exceeds ~200 lines or a second input source is added.
- Add `/clear` command to reset `Evaluator` history without restarting.
- Consider streaming responses (`stream: true`) when the blocking UX cost becomes real.
- Add integration tests in `vise-core` against a mock HTTP server (`wiremock` or a local `llama-server`) — these need no terminal.

## Performance

- **Inference latency** — dominated by the model, not the client. The client adds < 1 ms. Nothing to optimize until the model is local and fast.
- **History growth** — unbounded `Vec<Msg>` will eventually exceed context window. A sliding window or summary-based truncation will be needed; profile real usage before choosing a strategy.
- **Buffering** — `read_line` on `stdin` is fine. No need for `BufReader` in a one-line-at-a-time REPL.
