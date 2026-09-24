# vise — Architecture

A minimal, local-first REPL for a llama.cpp server (OpenAI-compatible API at `localhost:8080`).
Single user-facing surface: a line-based chat loop. No network other than the local server.

## Definitions

- **Turn**: one user line + one assistant reply. A turn is the unit of conversation history.
- **History**: the ordered list of completed turns, sent in full with every request.
  Invariant: history always ends on an assistant turn. A failed request must not leave
  a dangling user turn (transient errors must not pollute context).
- **Client**: the only module that knows the wire format (URLs, headers, JSON shape).
- **REPL**: the only module that knows the terminal (readline, prompts, exit words).
- **Config**: the single source of truth for the server URL, the _default_ model, and
  transport settings. No module may hardcode a URL or read an env var directly.
- **Default model**: the model selected at startup (the first entry in the server's
  model list, or `VISE_MODEL` once config supports it). Immutable; owned by config.
- **Active model**: the model string sent with each request. Session state owned by the
  REPL: it starts as the default model and changes only via `/model <name>`.

## Structure

```
vise/
  index.ts        # wiring only: main()
  src/
    client.ts     # send(), listModels()
    tools.ts      # tool definitions, executeToolCall()
    repl.ts       # ask(), handleCommand(), printEnvInfo(), maskKey()
    config.ts     # BASE_URL, loadEnv(), getApiKey(), authHeaders()
    types.ts      # RequestMessage, ToolCall, ToolResponse, ReplState, ReplDeps, ListModelsResult
  ARCHITECTURE.md # this file
```

Dependency direction (strictly one-way):

```
index.ts ──► client ──► config
  │        └──────► tools ──► (none)
  │        ──► repl   ──► config
  └────────► types    (types-only, no runtime imports)
```

Rules:

- `repl.ts` receives its dependencies as a parameter; it never imports `fetch` or `config`.
- `client.ts` owns the HTTP client (`send`) and model discovery (`listModels`).
  It imports tool execution from `tools.ts` and config from `config.ts`.
- `tools.ts` owns tool definitions and execution; it has no runtime dependencies
  beyond Node builtins.
- `index.ts` wires everything together and owns process-level concerns
  (startup errors, exit codes, `process.exit`).
- No module imports `index.ts`.

### Conversation state

History lives in the REPL layer, not the client: the client is stateless and
`chat(messages)` takes the full transcript, mirroring the HTTP API. This keeps
`client.ts` pure and trivially testable, and makes "what does the server see"
a pure function of the history array.

When tool calling is active, `send()` returns all messages it generated
(tool-calls assistant, tool results, final assistant). The REPL pushes them
all into history so the server sees the full tool transcript on the next turn.
This preserves the pure-function-of-history contract across turns: the history
array contains every message the server has ever seen, including intermediate
tool turns.

History invariants:

- Push the user turn **before** sending; on success, append all new messages
  returned by `send()` (tool turns + final assistant).
- On failure, roll back the user turn so the next request starts from a clean
  assistant-ending transcript.
- Never mutate a message after it has been appended (the server may stream;
  the REPL owns display).

## Potential Problems

- **Dangling user turn**: if a failure path forgets to roll back, the next request
  sends a transcript ending in a user message. The server tolerates it, but the
  model's reply will be a second assistant turn for the same user message.
  Guard: any new error path in `repl.ts` must end with `history.pop()`.
- **Silent model fallback**: if `getModelName()` fails, the client must not guess.
  Surface the error at startup; `config` is the only place a default model name
  may live.
- **Unbounded history**: the local server has no context-window awareness exposed
  to us. A very long session will eventually exceed the model's context and
  return a non-OK response. Watch for this; the fix is a `/clear` command
  (already planned) and possibly a token-budget trim, not client-side truncation
  of the user's message.
- **Startup ordering**: `listModels()` runs before the REPL opens. If it
  fails, the process must exit with a clear message, not fall into the REPL
  with a dead client.
- **Model list is not a chat-capability check**: `/v1/models` lists every loaded
  model, including embedding models (e.g. `nomic-embed-text`). Membership in the
  list does not prove the model can serve chat, so `/model <name>` can accept a
  model whose next turn fails server-side. The send-error message should point
  back to `/model`.
- **Stale active model**: the active model is validated only at switch time. If
  the server is restarted with a different `--model`, the cached string may no
  longer exist; the next request fails with an HTTP error.

## Future Work

1. **Commands** in the REPL: `/clear` (reset history to `[]`), and `/exit`
   (alias `exit`/`quit`). `/whoami` and `/model` are done.
2. **Structured error type** in `src/client.ts`: a `ClientError` discriminated union
   (`{ kind: "http", status, statusText } | { kind: "network", cause }`) instead
   of plain `Error`. `src/repl.ts` maps kinds to user-facing messages.
3. **Config from env/CLI**: `VISE_BASE_URL`, `VISE_MODEL`, or `--base-url` /
   `--model` flags. `config.ts` validates and merges; no other module reads env.
4. **Streaming**: `chat` gains an `onChunk` callback or returns an `AsyncIterable`.
   The REPL prints chunks as they arrive; history still gets the full message
   appended once on completion.
5. **`system` role**: a `--system` flag or `~/.vise/system.md` file. The client
   prepends a `system` message to the transcript; the REPL never constructs
   messages directly.

## Performance

Obvious concerns only — profile before optimizing:

- **Model load latency**: the first request to a cold llama.cpp server pays the
  full model-load cost. There is no warmup call; this is a startup-time concern,
  not a per-turn one.
- **Full-transcript re-send**: every request serializes the entire history.
  For a local server this is negligible. If it becomes measurable, the fix is
  server-side conversation state (a `chat_id` header), not client-side caching.
- **Prompt size vs. context window**: a long session's prompt grows linearly.
  Watch the non-OK response rate; the fix is `/clear`, not per-request trimming.
- **Single-flight**: the REPL awaits each request before accepting the next
  input, so there is no concurrency to optimize. Streaming (§5) changes this:
  the REPL must not accept a new turn until the stream completes.
