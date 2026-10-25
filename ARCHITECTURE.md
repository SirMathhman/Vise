# Architecture

Written for: developers working on the Vise monorepo.

## Definitions

- **Vise**: a local-first chat application that proxies user messages to a local llama.cpp (Strata) inference server and renders the reply in a web UI.
- **Strata**: the local inference server exposing an OpenAI-compatible `/v1/chat/completions` endpoint. Vise expects it at a configurable base URL (default `http://127.0.0.1:9931`).
- **Backend** (`apps/server`): a Rust axum HTTP service that receives chat requests from the web UI, runs an agentic loop against Strata (executing model-requested tools and feeding results back), and returns the model's final reply.
- **Agent loop**: the orchestration that repeatedly calls the model, executes any tool calls it emits, appends the results as `tool`-role messages, and repeats until the model produces a final text answer. This is a distinct layer from the HTTP handlers.
- **Tool**: a named capability (e.g. `list_files`) the model can invoke. Each tool is defined by a single source of truth — its `name`, `description`, parameter schema, and executor — and every projection (the OpenAI schema sent to the model, the human-readable list shown in the UI, the executor lookup) is derived from that one definition. A tool's identity and description must never be re-parsed out of a serialized schema; they are fields on the tool itself.
- **Frontend** (`apps/web`): a Vite + TypeScript single-page app that renders the chat form and displays responses.
- **Design tokens**: the single source of truth for the visual theme — every color, surface, border, shadow, and accent is declared once in a `:root` token block in `styles.css`. The rest of the stylesheet references only tokens (`var(--...)`), never raw color literals. A theme change (darkening, light mode, rebrand) is therefore one token-block edit, not a hunt through scattered values.
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
│   │       ├── routes.rs      # route definitions and thin handlers
│   │       ├── agent.rs       # agentic tool-calling loop (model ↔ tools)
│   │       ├── llama.rs       # Strata client (reqwest wrapper)
│   │       ├── tools/         # tool registry + one module per tool
│   │       │   ├── mod.rs     # Tool struct, registry, tool_schemas(), execute_tool()
│   │       │   ├── list_files.rs
│   │       │   ├── read_file.rs
│   │       │   ├── create_file.rs
│   │       │   ├── create_directory.rs
│   │       │   └── edit_file.rs
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

Within `server`, the layering is:

```
routes.rs ──▶ agent.rs ──▶ llama.rs ──▶ Strata
                │
                └──▶ tools/ (registry + one module per tool)
```

- `routes.rs` is a thin HTTP layer: it builds the request and delegates to `agent.rs`.
- `agent.rs` owns the model ↔ tools orchestration and is the only module that drives the loop.
- `tools/` is a registry plus one module per tool. Each tool module exposes a single `pub fn tool() -> Tool` that keeps its JSON schema and executor together so they cannot drift apart. `tools/mod.rs` holds the `Tool` struct, the `OnceLock`-backed registry (which just collects each module's `tool()`), and the two public projections `tool_schemas()` and `execute_tool()`. Adding a tool is one new file plus one line in the registry.
- `web` depends on `server` only via HTTP (and the shared OpenAPI contract).
- `server` depends on `Strata` only via HTTP.
- No Rust crate or TS module imports across the `apps/` boundary.

### Backend module layout

| Module | Responsibility | Max lines |
|--------|----------------|-----------|
| `main.rs` | Parse config, build router, bind listener, run axum | 50 |
| `config.rs` | Load and validate env vars into a `Config` struct | 50 |
| `routes.rs` | Define routes, extract state, construct the system prompt (working directory), delegate to the agent layer | 100 |
| `agent.rs` | Run the agentic tool-calling loop: call the model, execute tool calls, append `tool` results, repeat until a final text answer (bounded by a max-turns guard) | 150 |
| `llama.rs` | Wrap `reqwest` calls to Strata; map responses to typed structs (`AssistantReply`) | 100 |
| `tools/mod.rs` | `Tool` struct, `OnceLock` registry, `tool_schemas()`, `tool_list()`, `execute_tool()` | 50 |
| `tools/<name>.rs` | One tool: its JSON schema + executor, exposed as `pub fn tool() -> Tool` | 100 |
| `error.rs` | Define `AppError` enum with `IntoResponse` impl | 50 |

### Frontend module layout

| Module | Responsibility | Max lines |
|--------|----------------|-----------|
| `main.ts` | Mount the app, wire DOM | 30 |
| `app.ts` | Chat state (messages, loading, error), render loop | 100 |
| `api.ts` | Typed `fetch` wrappers matching `api.yaml` | 50 |
| `styles.css` | All visual styling. A `:root` design-token block is the single source of truth for the theme; every other rule references only tokens, never raw color literals | — |

## Potential Problems

- **Secrets in source**: any API key or model identifier hardcoded in `main.rs` will leak to anyone with repo access. Configuration must come from the environment.
- **No timeout on upstream calls**: a hung Strata process will hold the request open indefinitely. Every outbound HTTP call needs a connect + read timeout.
- **No conversation persistence**: the UI maintains an in-memory message list across turns, but it is lost on page reload. A chat application needs persistence across sessions (a local store).
- **No CORS**: the Vite dev proxy masks the absence of CORS headers. In production (or any non-dev origin), the browser will block the request. The backend must set `Access-Control-Allow-Origin` and handle `OPTIONS` preflights.
- **No streaming**: the entire model response is buffered before being sent. For a chat UI, token-by-token streaming (SSE or chunked transfer) is the expected UX.
- **No request validation**: `message: String` accepts an empty string, a 10 MB blob, or binary garbage. Validate length and content type at the boundary.
- **Unbounded tool output**: a tool result (e.g. a deep `list_files` walk) is appended verbatim to the prompt. A large result can blow the context window or make the next model call slow. Tool results should be truncated/capped at the boundary, and the max-turns guard should surface a distinct error so the client can tell the loop stalled.
- **Tool loop is not observable in real time**: tool calls are now surfaced in the final response, but the user sees nothing while the loop is running. A stalled loop still looks like a hang. Streaming (SSE) is required so the UI can show tool activity as it happens, and a distinct "tool loop exceeded" error so the client can tell the loop stalled.
- **No health-check depth**: `/health` returns `"ok"` without verifying Strata reachability. A real health endpoint should report upstream status.
- **No accessibility**: the input has no `<label>`, the response region has no `aria-live`, and there are no visible focus indicators. Screen-reader users cannot follow the conversation.
- **Nested scroll contexts**: the chat log (`#chat-log`) is the single scroll container for the conversation. Unbounded inner content (e.g. a long tool result) must grow naturally inside it, not carry its own `overflow` + `max-height`. Two stacked scrollbars for the same content are confusing and hard to use; if a region truly needs independent scrolling, it belongs in a sibling panel or modal, not nested inside the log.
- **No linter or formatter**: neither the Rust nor the TypeScript side has a linter, formatter, or size guard configured. Drift is invisible until it accumulates.
- **Module line budgets are not enforced**: `llama.rs` is at 111 lines against its documented 100-line budget (the response-parsing block in `chat_completion` is the bulk of the overage). Extract the `choices[0].message` → `AssistantReply` mapping into a small helper so `llama.rs` stays within budget and the parsing is independently testable.
- **Theme drift**: the stylesheet declares a complete design-token set in `:root` and every other rule references only tokens (`var(--...)`), never raw color literals. A theme change (darkening, light mode, rebrand) is a single token-block edit. If a future change reintroduces raw color literals outside the token block, the theme can drift internally — keep all colors in `:root`.

## Future Work

- **OpenAPI contract**: define `api.yaml` with the `/health`, `/api/tools`, and `/api/chat` endpoints, request/response schemas, and error model. Use `@openapitools/openapi-generator-cli` (already in devDependencies) to generate the TypeScript client in `apps/web/src/api.ts` and validate the Rust handlers against the spec.
- **Tool registry**: `tools/mod.rs` holds a `OnceLock`-backed registry of `Tool` entries. Each `Tool` carries its `name`, `description`, parameter schema, and executor as first-class fields, and the OpenAI-style schema is *derived* from those fields rather than hand-written in parallel. `tool_schemas()` (sent to the model), `tool_list()` (shown in the UI), and `execute_tool()` (lookup by name) are all projections of the same registry entry, so adding a tool is one entry and no projection can drift from the others. Unknown-tool errors stay uniform.
- **Streaming**: switch the chat endpoint to stream tokens back as SSE (`text/event-stream`). The frontend renders tokens as they arrive, replacing the "…" placeholder incrementally.
- **CORS middleware**: add `axum-extra::middleware::cors` (or a manual layer) so the backend works from any origin in production.
- **Timeouts**: set `reqwest` connect and read timeouts (e.g. 5 s connect, 120 s read for a 27B model). Surface a `Timeout` error to the client.
- **Accessibility**: add `aria-live="polite"` to the response region and a `<label>` to the input.
- **Linting**: add `clippy` + `rustfmt` for Rust and `eslint` + `prettier` for TypeScript. Wire them into `pnpm dev` or a `pnpm lint` script.
- **Testing**: add `cargo test` for the backend (config parsing, error mapping, route handlers with a mocked Strata) and Vitest for the frontend (rendering, state transitions).

## Performance

- **Model inference dominates**: a 27B GGUF model on a local GPU takes seconds to tens of seconds per response. The backend's overhead (HTTP round-trip, JSON parsing) is negligible by comparison. Optimize the model, not the proxy.
- **Streaming latency**: the first token is the user-visible latency. Buffering the full response before sending adds the entire generation time to perceived latency. Streaming (SSE) removes this.
- **Connection pooling**: `reqwest::Client` already pools connections. Ensure it is created once and shared via axum state (it is).
- **Frontend rendering**: for long conversations, the DOM will grow. If the message list exceeds a few hundred entries, virtualize or paginate. This is not a concern at the current scale.
