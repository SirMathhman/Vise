## Plan: Rust WS Conversation Pump + First LLM Call

The Rust server accepts a `line` message over `/ws`, makes a single HTTP call to the local llama.cpp server, streams tokens back as `token` messages, and closes the turn. Also: `/ext` WebSocket with pairing token check and browser-op round-trip. No tools, no steering, no multi-turn yet — just the transport pump that proves the Rust→LLM→WS pipeline works end-to-end.

**Steps**

### Phase 1 — JSON + config foundation

1. Add dependencies to `crates/vise-rs/Cargo.toml`:
   - `serde` (with `derive`) + `serde_json` — message serialization.
   - `reqwest = { version = "0.12", features = ["stream"] }` — HTTP client for the LLM. (Chosen over hyper-client: cleaner streaming API, and the server/client use of hyper are independent.)
   - `rand = "0.8"` — for generating the extension pairing token.
   - `hex = "0.4"` — token hex encoding.

2. Create `crates/vise-rs/src/config.rs` — a minimal config struct:
   - `llm_base_url: String` (default `http://localhost:8080`)
   - `llm_model: String` (default `"local"`)
   - `llm_api_key: String` (default `""`) — Bearer token for the llama.cpp server.
   - `port: u16` (default 3000, overridable via `--port=N` as before).
   - Read from env vars `VISE_LLM_BASE_URL`, `VISE_LLM_MODEL`, `VISE_LLM_API_KEY` if set, else defaults.
   - No file-based config yet (that comes with settings persistence).

### Phase 2 — WS message types (the pump)

3. Create `crates/vise-rs/src/conn.rs` — per-connection state:
   - Holds a `reqwest::Client` (shared across connections, created once at startup).
   - Holds a reference to the config.
   - Holds a `Vec<serde_json::Value>` as the message history (just `[{role, content}]` pairs for now).
   - The `handle_line(text: &str)` method:
     a. Append `{role:"user", content: text}` to history.
     b. Build the LLM request body (see Phase 3).
     c. Stream the response, sending `{"type":"token","text":"..."}` for each token chunk.
     d. On stream end, append `{role:"assistant", content: accumulated}` to history.
     e. Send `{"type":"exit"}` to the client.
   - On connect (before any message): send `root` then `goal_state` (see Phase 4).
   - On `interrupt` message: cancel the in-flight reqwest request (abort the stream). Send `{"type":"exit"}`.
   - On `ask_answer`: for now just append as a user message and reply `{"type":"exit"}` (real ask handling is later).

### Phase 3 — LLM HTTP call

4. Create `crates/vise-rs/src/llm.rs` — the llama.cpp client:
   - `async fn chat_stream(client: &reqwest::Client, config: &Config, messages: &[Value]) -> impl Stream<Item = Result<String, Error>>`
   - POST to `{base}/v1/chat/completions`.
   - Headers: `Content-Type: application/json`, `Authorization: Bearer {api_key}` (if non-empty).
   - Body: `{"model": config.llm_model, "messages": messages, "stream": true, "max_tokens": 4096}`.
     - Start minimal: just `model`, `messages`, `stream`, `max_tokens`. The other fields (`dry_multiplier`, `reasoning_effort`, `grammar`, `id_slot`, `return_progress`, `timings_per_token`, `response_format`, `stream_options`) are added in later phases when tools/streaming-metrics arrive.
   - Parse the SSE response:
     - Read lines from the response body stream.
     - Lines starting with `data: ` → `serde_json::from_str` the remainder.
     - If the parsed JSON has `choices[0].delta.content` → yield that string (a token chunk).
     - If the parsed JSON has `choices[0].finish_reason` → signal end.
     - If the line is `data: [DONE]` → end.
   - Accumulate all token strings into the full assistant message.

### Phase 4 — Handshake + /ext

5. On WS connect to `/ws` (after upgrade, before reading the first message):
   - Send `{"type":"root","path":"","noFolder":false}` (no folder resolution yet — empty root is fine for the pump).
   - Send `{"type":"goal_state","enabled":true}`.

6. Create `crates/vise-rs/src/ext.rs` — the `/ext` handler:
   - On connect: check the `?token=` query param against the stored pairing token.
     - Token stored at `~/.vise/ext-token` (32 random bytes, hex-encoded). Generate and write it on first run if absent.
     - Reject (close WS) if token missing or mismatch.
   - On accept: send `{"config":{"tabLimit":3}}`.
   - Incoming messages:
     - `{"id":N, "ok":true, "result":...}` or `{"id":N, "ok":false, "error":"..."}` → resolve the pending op (store a `HashMap<i64, oneshot::Sender<Value>>` for in-flight ops).
     - `{"event":"tabs"}` or `{"event":"shared"|"released", "tab":...}` → log/ignore for now (no browser tools yet).
   - `call(op: &str, params: Value) -> Result<Value, String>` — send `{"id":next_id, "op":op, "params":params}`, await the response with a 30s timeout. (Called by browser tools later; for now just wire the plumbing.)
   - One extension at a time: a new connection replaces the old (close the previous socket).

### Phase 5 — wire it up in main.rs

7. In `main.rs`, the WS handler on `/ws`:
   - After upgrade, create a `Conn` (Phase 2).
   - Send the handshake messages (Phase 4).
   - Read loop: parse each incoming text frame as JSON, dispatch on `.type`:
     - `"line"` → `conn.handle_line(msg["text"].as_str().unwrap_or("").to_string())`
     - `"interrupt"` → abort the current request, send `{"type":"exit"}`.
     - `"ask_answer"` → stub: send `{"type":"exit"}`.
     - anything else → ignore (unknown messages are dropped, matching the TS router's default).
   - The read loop runs concurrently with the handler (tokio select or a channel).

8. In `main.rs`, the WS handler on `/ext`:
   - After upgrade, create an `ExtHub` (Phase 6).
   - Read loop: parse frames, dispatch to the hub.

### Phase 6 — verification

9. **Manual test** — start the Rust server (`cargo run`), open a browser to `http://localhost:PORT`, open dev tools → WS:
   - [ ] On connect, the client receives `{"type":"root",...}` then `{"type":"goal_state",...}`.
   - [ ] Type a message (e.g. "hello") → the client receives `token` messages streaming, then `{"type":"exit"}`.
   - [ ] The streamed text matches what llama.cpp would return.
   - [ ] Send a second `line` → the second turn works (history is maintained).
   - [ ] `interrupt` mid-stream → the stream stops, `exit` is sent.
   - [ ] `/ext` without a token → connection closes.
   - [ ] `/ext` with the correct token → receives `{"config":{"tabLimit":3}}`.

10. **No TypeScript changes** — this phase touches only `crates/vise-rs/`. The Bun server is untouched.

**Relevant files**

- `crates/vise-rs/src/main.rs` — existing; add conn/ext handlers to the WS dispatch.
- `crates/vise-rs/src/conn.rs` — NEW: per-connection state, `handle_line`.
- `crates/vise-rs/src/llm.rs` — NEW: `chat_stream` function.
- `crates/vise-rs/src/ext.rs` — NEW: `ExtHub` with `call`.
- `crates/vise-rs/src/config.rs` — NEW: config struct.
- `packages/core/src/client/llm.ts` — reference for the LLM request body and SSE parsing.
- `apps/web/src/conn/open.ts` — reference for the handshake message order.
- `apps/web/src/ext/ext-hub.ts` — reference for the /ext protocol.
- `apps/web/src/ext/ext-token.ts` — reference for token generation/storage.

**Verification**

1. `cargo build --release` succeeds with no warnings.
2. Start the server; `curl -s http://localhost:PORT/` still returns 200 (static serving unchanged).
3. WS test: connect to `ws://localhost:PORT/ws`, verify the `root` + `goal_state` handshake arrives.
4. WS test: send `{"type":"line","text":"hello"}`, verify `token` messages stream back, then `{"type":"exit"}`.
5. WS test: send `line` twice — verify the second turn includes the first turn in the LLM request (check by asking "what did I just say?").
6. WS test: send `interrupt` during a stream — verify tokens stop and `exit` arrives.
7. /ext test: connect to `ws://localhost:PORT/ext` without token — verify immediate close.
8. /ext test: connect with `?token=<correct>` — verify `{"config":{"tabLimit":3}}` is received.
9. /ext test: send a fake `{"id":1, "ok":true, "result":"test"}` — no crash (op is resolved or pending map is cleaned up).

**Decisions**

- **reqwest over hyper-client** — reqwest's `stream()` feature gives a clean `bytes::Bytes` stream from the response body; hyper's client API is lower-level and would require manual chunk reassembly for SSE. Since reqwest is a one-line dependency, it wins.
- **Minimal LLM body for now** — only `model`, `messages`, `stream`, `max_tokens`. The full body (dry settings, reasoning_effort, grammar, tool fields, id_slot) is added when tools and streaming metrics arrive. This keeps the first LLM call simple and the SSE parsing trivial.
- **No folder/root resolution** — the `root` message sends empty path. Folder resolution (picking a working directory, git status, MCP startup) is a later concern. The conversation works fine with an empty root for the pump.
- **No tool parsing** — the LLM response is treated as plain text (no `<|tool_call|>` parsing). The full assistant message is accumulated and stored in history. Tool calls are a later phase.
- **One extension at a time** — matches the TS behavior. A new `/ext` connection closes the previous one.
- **Token at `~/.vise/ext-token`** — matches the TS path. 32 random bytes, hex-encoded, written on first run, compared byte-for-byte on connect.

**Further Considerations**

1. **When to add tool parsing** — the moment the model emits `<|tool_call|>{...}</|tool_call|>` in its response, the pump needs to detect it, execute the tool, and loop. That's the "full conversation loop" phase. The current pump treats the response as pure text.
2. **When to add folder resolution** — when the user wants the conversation to be rooted in a project (file tools, git status, MCP). For now empty root is fine.
3. **When to add `steer`/`unqueue`** — steering mid-turn requires the engine to interleave user input with the ongoing generation. That's a later phase.
