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
  model list, or `VISE_MODEL` when set). Immutable; owned by config.
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
    config.ts     # getBaseUrl(), loadEnv(), getApiKey(), authHeaders()
    types.ts      # RequestMessage, ToolCall, ToolResponse, ReplState, ReplDeps, ListModelsResult, ClientError
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

- `repl.ts` receives its dependencies as a parameter; it never imports `fetch`.
  It may import `config` for display values (`getBaseUrl`, `getApiKey`) via
  `printEnvInfo`/`/whoami`, but performs no other config reads.
- `client.ts` owns the HTTP client (`send`) and model discovery (`listModels`).
  It imports tool execution from `tools.ts` and config from `config.ts`.
- `tools.ts` owns tool definitions and execution; it has no runtime dependencies
  beyond Node builtins.
- `index.ts` wires everything together and owns process-level concerns
  (startup errors, exit codes, `process.exit`).
- No module imports `index.ts`.

### REPL commands

`repl.ts` recognizes two kinds of input lines: **chat commands** (routed through
`handleCommand`, which mutates `ReplState` or prints info, then the loop
continues) and **exit words** (handled directly in `ask()`, the readline
owner, because they tear down the terminal via `rl.close()`).

Chat commands:

- `/whoami` — print server, model, masked API key, runtime.
- `/model` — list models, `*` marking the active one.
- `/model <name>` — switch the active model (validated against the list).
- `/clear` — reset `state.history` to `[]`.

Exit words (all close the readline interface and end the process): `exit`,
`quit`, `/exit`.

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

### Tool execution

`tools.ts` is the module that owns the filesystem: every tool that touches the
disk lives here, and no other module opens a file or lists a directory.

- **Definitions**: each tool is an OpenAI function object (`LIST_FILES_TOOL`,
  `READ_FILE_TOOL`). The `tools` array is what `client.ts` sends in every
  request, so the model sees the full schema.
- **Execution**: `executeToolCall(call)` runs a single tool and returns a
  `ToolResponse`. **Contract: it must never throw** — every failure (missing
  file, unreadable directory, unknown tool name) is folded into a
  `ToolResponse` whose `content` is an error string the model can read.
  `client.ts` calls `executeToolCall` inline during its tool-call loop; there is
  no separate tool-execution module because the tools are simple, local, and
  synchronous with the request.
- **Arbitrarily large files**: `read_file` streams via `createReadStream` +
  readline and collects only the requested line range, so a huge file is never
  held in memory whole. `truncated` is `true` only when reading stopped early
  at `endLine` (more may exist beyond); `false` when EOF was reached.

## Configuration

`config.ts` is the only module that reads configuration. Every value is read at
**call time** (never a module-level constant) so the value reflects the
process environment and the `.env` file loaded by `loadEnv()`. No other module
reads an env var directly.

| Variable         | Source                        | Effect                                          |
|------------------|-------------------------------|-------------------------------------------------|
| `VISE_BASE_URL`  | env / `.env`                  | Overrides the server URL (default `http://localhost:8080`). |
| `VISE_MODEL`     | env / `.env`                  | Sets the **default** model. Validated against the server's model list at startup; an unknown name exits with a clear message. |
| `VISE_API_KEY`   | env / `.env`                  | Bearer token sent on every request. Optional.   |

The base URL is exposed as `getBaseUrl()`; the default model is resolved in
`index.ts` startup (the only place that owns the default-model choice), then
passed into `ReplState` as the active model. CLI flags (`--base-url`,
`--model`) are not yet implemented — see Future Work.

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
  return a non-OK response. `/clear` lets the user reset history at will; a
  token-budget trim could go further, but neither should truncate the user's
  message client-side.
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

### Error handling

`send()` in `client.ts` throws a `ClientError` discriminated union (defined in
`types.ts`) on failure, not a plain `Error`. The REPL pattern-matches on `kind`:

- `{ kind: "http", status, statusText, body? }` — the server responded with a
  non-OK status. The client captures a 200-char snippet of the response body
  (where llama.cpp's OpenAI-compatible endpoint reports the actual cause, e.g.
  `{"error": "model 'X' not loaded"}`) and the REPL prints it inline with the
  status plus a hint to check `/model`.
- `{ kind: "network", cause }` — the fetch itself failed (connection refused,
  DNS, etc.). The REPL prints the underlying cause.

Other exceptions (e.g. the max-iteration guard) fall through to a generic
`Error:` message.

## Future Work

1. **Config CLI flags**: `--base-url` / `--model` flags to complement the existing
   `VISE_BASE_URL` / `VISE_MODEL` env vars. `config.ts` merges env + flags
   (flags win); no other module reads args. Env vars are already wired.
2. **Streaming**: `chat` gains an `onChunk` callback or returns an `AsyncIterable`.
   The REPL prints chunks as they arrive; history still gets the full message
   appended once on completion.
3. **`system` role**: a `--system` flag or `~/.vise/system.md` file. The client
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
