# Architecture

Written for: developers working on the Vise monorepo.

## Definitions

- **Vise**: a local-first chat application that proxies user messages to a local llama.cpp (Strata) inference server and renders the reply in a web UI.
- **Strata**: the local inference server exposing an OpenAI-compatible `/v1/chat/completions` endpoint. Vise expects it at a configurable base URL (default `http://127.0.0.1:9931`).
- **Backend** (`apps/server`): a Rust axum HTTP service that receives chat requests from the web UI, forwards them to Strata, and returns the model's reply.
- **Frontend** (`apps/web`): a Vite + TypeScript single-page app that renders the chat form and displays responses.
- **API contract** (`packages/api`): the OpenAPI specification (`api.yaml`) that describes the backend's HTTP surface. Client code and server handlers should be derived from or validated against this spec.

## Invariants

- The backend is the **only** component that talks to Strata. The frontend never calls Strata directly.
- All secrets (API keys, model identifiers, base URLs) are supplied at runtime via environment variables, never committed to source.
- The backend exposes a minimal, well-typed HTTP surface. Every endpoint is described in `api.yaml` before or at the same time it is implemented.
- The frontend is a thin presentation layer: it renders state and forwards user intent. It holds no business logic beyond formatting.

## Structure

```
Vise/
├── apps/
│   ├── server/          # Rust (axum) backend
│   │   └── src/
│   │       ├── main.rs        # entry point, wiring
│   │       ├── config.rs      # env-var-backed configuration
│   │       ├── routes.rs      # route definitions and handlers
│   │       ├── llama.rs       # Strata client (reqwest wrapper)
│   │       └── error.rs       # structured error types
│   └── web/             # Vite + TypeScript frontend
│       └── src/
│           ├── main.ts        # entry point
│           ├── app.ts         # chat state and rendering
│           ├── api.ts         # typed fetch wrappers (generated or hand-written from api.yaml)
│           └── styles.css     # layout, typography, responsive rules
├── packages/
│   └── api/
│       └── api.yaml           # OpenAPI 3.x spec for the backend
└── package.json               # pnpm workspace root
```

### Dependency direction

```
web ──HTTP──▶ server ──HTTP──▶ Strata
                │
                └── api.yaml (shared contract)
```

- `web` depends on `server` only via HTTP (and the shared OpenAPI contract).
- `server` depends on `Strata` only via HTTP.
- No Rust crate or TS module imports across the `apps/` boundary.

### Backend module layout

| Module | Responsibility | Max lines |
|--------|----------------|-----------|
| `main.rs` | Parse config, build router, bind listener, run axum | 50 |
| `config.rs` | Load and validate env vars into a `Config` struct | 50 |
| `routes.rs` | Define routes, extract state, call domain logic | 100 |
| `llama.rs` | Wrap `reqwest` calls to Strata; map responses to typed structs | 100 |
| `error.rs` | Define `AppError` enum with `IntoResponse` impl | 50 |

### Frontend module layout

| Module | Responsibility | Max lines |
|--------|----------------|-----------|
| `main.ts` | Mount the app, wire DOM | 30 |
| `app.ts` | Chat state (messages, loading, error), render loop | 100 |
| `api.ts` | Typed `fetch` wrappers matching `api.yaml` | 50 |
| `styles.css` | All visual styling | — |

## Potential Problems

- **Secrets in source**: any API key or model identifier hardcoded in `main.rs` will leak to anyone with repo access. Configuration must come from the environment.
- **Unstructured errors**: returning `(StatusCode, String)` tuples makes it impossible for the frontend to distinguish "Strata is down" from "bad request" from "timeout." A typed error enum with a stable error code field is required.
- **No timeout on upstream calls**: a hung Strata process will hold the request open indefinitely. Every outbound HTTP call needs a connect + read timeout.
- **No conversation history**: the current UI shows only the last exchange. A chat application needs a message list that persists across turns (at minimum in memory; later in a local store).
- **No CORS**: the Vite dev proxy masks the absence of CORS headers. In production (or any non-dev origin), the browser will block the request. The backend must set `Access-Control-Allow-Origin` and handle `OPTIONS` preflights.
- **No streaming**: the entire model response is buffered before being sent. For a chat UI, token-by-token streaming (SSE or chunked transfer) is the expected UX.
- **No request validation**: `message: String` accepts an empty string, a 10 MB blob, or binary garbage. Validate length and content type at the boundary.
- **No health-check depth**: `/health` returns `"ok"` without verifying Strata reachability. A real health endpoint should report upstream status.
- **Unstyled UI**: the frontend has no CSS. Default browser rendering (Times New Roman headings, monospace `<pre>`, no spacing) is not a design. Layout, typography, contrast, focus states, and responsive behavior all need explicit rules.
- **No accessibility**: the input has no `<label>`, the response region has no `aria-live`, and there are no visible focus indicators. Screen-reader users cannot follow the conversation.
- **No linter or formatter**: neither the Rust nor the TypeScript side has a linter, formatter, or size guard configured. Drift is invisible until it accumulates.

## Future Work

- **Configuration**: load `LLAMA_BASE`, `LLAMA_API_KEY`, `LLAMA_MODEL`, and `SERVER_PORT` from environment variables (with sensible defaults for local dev). Fail fast with a clear message if a required variable is missing.
- **OpenAPI contract**: define `api.yaml` with the `/health` and `/api/chat` endpoints, request/response schemas, and error model. Use `@openapitools/openapi-generator-cli` (already in devDependencies) to generate the TypeScript client in `apps/web/src/api.ts` and validate the Rust handlers against the spec.
- **Structured errors**: define an `AppError` enum (`Upstream`, `Timeout`, `BadRequest`, `Internal`) with a stable `code` string and a human-readable `message`. Implement `IntoResponse` to map each variant to the correct status and JSON body.
- **Streaming**: switch the chat endpoint to stream tokens back as SSE (`text/event-stream`). The frontend renders tokens as they arrive, replacing the "…" placeholder incrementally.
- **Conversation state**: maintain a message list in the frontend (and optionally in the backend for multi-turn context). Each turn appends to the list; the UI renders the full history.
- **CORS middleware**: add `axum-extra::middleware::cors` (or a manual layer) so the backend works from any origin in production.
- **Timeouts**: set `reqwest` connect and read timeouts (e.g. 5 s connect, 120 s read for a 27B model). Surface a `Timeout` error to the client.
- **Frontend styling**: write `styles.css` with a system font stack, consistent spacing scale, visible focus rings, a message list layout, and responsive breakpoints. Add `aria-live="polite"` to the response region and a `<label>` to the input.
- **Linting**: add `clippy` + `rustfmt` for Rust and `eslint` + `prettier` for TypeScript. Wire them into `pnpm dev` or a `pnpm lint` script.
- **Testing**: add `cargo test` for the backend (config parsing, error mapping, route handlers with a mocked Strata) and Vitest for the frontend (rendering, state transitions).

## Performance

- **Model inference dominates**: a 27B GGUF model on a local GPU takes seconds to tens of seconds per response. The backend's overhead (HTTP round-trip, JSON parsing) is negligible by comparison. Optimize the model, not the proxy.
- **Streaming latency**: the first token is the user-visible latency. Buffering the full response before sending adds the entire generation time to perceived latency. Streaming (SSE) removes this.
- **Connection pooling**: `reqwest::Client` already pools connections. Ensure it is created once and shared via axum state (it is).
- **Frontend rendering**: for long conversations, the DOM will grow. If the message list exceeds a few hundred entries, virtualize or paginate. This is not a concern at the current scale.
