## Plan: Rust Backend Skeleton (Phase 0 of full B replacement)

A bare Rust process that serves the frontend and accepts WebSocket connections — the shell a future Rust conversation engine will live in. No conversation logic, no tools, no HTTP API routes (just static files + `/ws` ping/pong). Both the Bun and the Rust server can run side by side during development.

**Scope boundaries**

- **In:** HTTP static file serving, Host-header rejection, port selection (same algorithm as `choosePort`), WebSocket upgrade on `/ws` and `/ext` with ping/pong echo, a clean binary that runs on Windows.
- **Out (everything else is later phases):** all `/api/*` HTTP routes, the conversation loop, LLM client, tool protocol, goal loop, compaction, MCP, browser backend, semantic index, terminal panel, `/ext-token` pairing, WebView2 window, embedded assets. The Rust server is a *transport placeholder* only.

**Steps**

### Phase 0 — crate setup

1. Create `crates/vise-rs/` in the repo root (new top-level `crates/` directory, alongside `apps/` and `packages/`).
   - `Cargo.toml`: `vise-rs` binary crate, `edition = "2021"`, MSRV 1.80.
   - Dependencies (all in `Cargo.toml`):
     - `hyper = "1"` — the only HTTP server dep.
     - `tokio = { version = "1", features = ["rt-multi-thread", "macros", "net", "sync"] }` — async runtime.
     - `tokio-tungstenite = { version = "0.26", features = ["server"] }` — minimal WS protocol implementation (not a router/framework, just the RFC 6455 framing).
     - `bytes = "1"` — buffer type hyper uses.
     - `http-body-util = "0.1"` — hyper's body trait (required for `hyper::Body` constructors).
   - No axum, no actix, no tower, no serde in this phase (JSON parsing isn't needed yet).
   - `.gitignore` entry: `crates/vise-rs/target/`.

### Phase 1 — HTTP static file server

2. `crates/vise-rs/src/main.rs` — single file for now (split if it grows past ~100 lines).

   a. **Port selection** — reimplement `choosePort` from `apps/web/src/port.ts`:
      - Bind a probe to `127.0.0.1:PORT` (default 3000, overridable via `--port=N` CLI arg).
      - If busy, scan `PORT+1` through `PORT+100` for the first free.
      - If still busy, bind to port `0` and use whatever the OS gives.
      - Print the resolved port and any busy-port note to stdout (matching `startWebServer`'s output).
      - Bind the actual listener to `127.0.0.1:RESOLVED_PORT`.

   b. **Request handler** — a `hyper::service::service_fn` with a `match` on `(method, path)`:
      - Any method on `/ws` or `/ext` → handled by the WS upgrade path (step 3).
      - `GET` on the 4 asset paths → serve the file with the correct `Content-Type`:
        | path | file (relative to repo root) | Content-Type |
        |---|---|---|
        | `/` | `packages/frontend/index.html` | `text/html; charset=utf-8` |
        | `/index.html` | same | same |
        | `/icon.svg` | `assets/icon.svg` | `image/svg+xml` |
        | `/dist/app.js` | `packages/frontend/dist/app.js` | `text/javascript; charset=utf-8` |
        | `/dist/app.css` | `packages/frontend/dist/app.css` | `text/css; charset=utf-8` |
      - Everything else → `404`.

   c. **Host-header check** — before serving any request (including static files), inspect the `Host` header:
      - Must be exactly `localhost:PORT` or `127.0.0.1:PORT` where `PORT` is the resolved port. Anything else → `403`.
      - This mirrors the DNS-rebinding guard in `apps/web/src/server.ts`.

   d. **Reading files** — read from disk on every request (no caching, no embedding). Paths are resolved relative to the current working directory. If a file is missing, return `500` with a body naming the path. This is development-only; embedding comes when the Rust server is production.

3. **WebSocket placeholder** — on a `GET` with `Upgrade: websocket` on `/ws` or `/ext`:
   - Perform the WS upgrade using `tokio-tungstenite`'s `accept`.
   - On the accepted stream, loop: read frames, and for every `Ping` frame write back a `Pong` with the same payload. Ignore text/binary frames (drop them). This is the minimum the browser needs to keep the connection alive.
   - No handshake validation beyond what `tokio-tungstenite::accept` does (Origin checking is a later phase).

4. **CLI args** — `--port=N` (default 3000). No other flags. Parse by hand (no `clap` or `structopt` in this phase).

### Phase 2 — build and verify

5. **Build** — `cargo build --release` from `crates/vise-rs/`, producing `crates/vise-rs/target/release/vise-rs.exe`.

6. **Run side by side** — from the repo root:
   - `cargo run --release` (or run the exe directly) → starts on port 3000.
   - Open `http://localhost:3000` in a browser.

7. **Verification checklist**:
   - [ ] `GET /` returns `index.html` with correct content-type.
   - [ ] `GET /dist/app.js` returns the bundled JS.
   - [ ] `GET /dist/app.css` returns the bundled CSS.
   - [ ] `GET /icon.svg` returns the SVG.
   - [ ] `GET /api/fs` returns `404` (not yet implemented — expected).
   - [ ] Request with `Host: evil.com:3000` returns `403`.
   - [ ] Request with `Host: localhost:3000` returns `200`.
   - [ ] WebSocket to `ws://localhost:3000/ws` connects and stays connected (browser dev tools → Network → WS → the page's status pill shows "connected" or at least doesn't error on connect).
   - [ ] Port 3000 already in use: server starts on 3001 and prints the note.
   - [ ] `Ctrl+C` shuts the process down cleanly (exit code 0, no orphan threads).

8. **No TypeScript changes** — this phase touches only `crates/vise-rs/` and possibly a root `.gitignore` entry. The Bun server is untouched and can run on a different port simultaneously.

**Relevant files**

- `apps/web/src/port.ts` — the `choosePort` algorithm to reimplement (lines ~1–40).
- `apps/web/src/server.ts` — the Host-header check pattern and the dispatch order.
- `apps/web/src/assets.ts` — the static file map (`WEB_ASSETS`): exact paths and content types.
- `apps/web/src/main.ts` — the entry point: how the port is resolved, how the server starts, how shutdown works (SIGINT/SIGTERM → exit 130).
- `packages/frontend/src/connection.ts` — what the page connects to (`/ws`), how it reconnects. No changes needed; just the protocol the page expects.

**Decisions**

- **No axum/actix** — raw `hyper` + `service_fn` with a `match` on path. The route table is 5 entries; a router macro is overhead.
- **`tokio-tungstenite` for WS** — it's the RFC 6455 implementation, not a framework. It's the minimum that gives correct framing without hand-rolling varint masks. Replacing it with a hand-rolled encoder is possible later but not worth it for a placeholder.
- **Files read from disk, not embedded** — embedding (like `src/web/assets.ts` does with `import ... with { type: "file" }`) is a production concern. For a dev skeleton, reading from disk is simpler and means the developer can edit the frontend bundle and refresh.
- **No `/api/*` routes yet** — the page will show "disconnected" after the WS connects because no conversation is established, but the UI shell renders. The `/api/vise-hello` probe (used by the Firefox extension to find the port) will also 404, which is fine; the extension isn't in scope.
- **No Origin validation on WS** — the Bun server checks `Origin` on `/ws` (must be local) and on `/ext` (must be `moz-extension://` + token). The Rust placeholder skips this; it's added when real conversation logic arrives.
- **Windows-first** — the binary targets x86_64-pc-windows-msvc (the default on Windows). No `#[cfg]` guards needed yet; the code is portable by accident (just TCP + file I/O).

**Further Considerations**

1. **When to add `/api/vise-hello`** — the moment the Firefox extension needs to find the Rust server's port. Trivial addition (one `GET` route returning `{ "vise": true }`).
2. **When to add Origin checking** — when the first real WS message is sent over the connection (the `root` message). Until then the placeholder is safe on loopback.
3. **When to embed assets** — when the Rust server replaces `vise.exe` as the single artifact. For now, running it from the repo root with `cargo run` is the intended dev workflow.
