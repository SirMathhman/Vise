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
- **Config**: the single source of truth for the server URL, the *default* model, and
  transport settings. No module may hardcode a URL or read an env var directly.
- **Default model**: the model selected at startup (the first entry in the server's
  model list, or `VISE_MODEL` once config supports it). Immutable; owned by config.
- **Active model**: the model string sent with each request. Session state owned by the
  REPL: it starts as the default model and changes only via `/model <name>`.

## Structure

```
vise/
  index.ts        # entry point: parse config, construct client, run REPL
  src/
    config.ts     # load/validate config (env vars, CLI flags, defaults)
    client.ts     # LlamaClient: listModels(), chat(messages, model) -> Reply
    repl.ts       # runRepl(client, opts): prompt loop, /whoami, /model, exit, /clear, /exit
  ARCHITECTURE.md # this file
```

Dependency direction (strictly one-way):

```
index.ts ──► config ──► client ──► (fetch)
   └──────► repl ──► client
```

Rules:

- `repl.ts` receives a client as a dependency; it never imports `fetch` or `config`.
- `client.ts` receives its base URL and model from `config`; it never reads env vars.
- `index.ts` wires everything together and owns process-level concerns
  (startup errors, exit codes, `process.exit`).
- No module imports `index.ts`.

### Conversation state

History lives in the REPL layer, not the client: the client is stateless and
`chat(messages)` takes the full transcript, mirroring the HTTP API. This keeps
`client.ts` pure and trivially testable, and makes "what does the server see"
a pure function of the history array.

History invariants:

- Push the user turn **before** sending; on success, append the assistant turn.
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

1. **Split `index.ts`** into `src/client.ts`, `src/repl.ts`, `src/config.ts`
   per the structure above. `index.ts` becomes ~15 lines of wiring.
2. **Commands** in the REPL: `/whoami` (environment), `/model [name]` (list or switch
   the active model), `/clear` (reset history to `[]`), and `/exit` (alias `exit`/`quit`).
   As commands accumulate, extract a `handleCommand(text, session, client): Promise<boolean>`
   so `ask()` stays a thin prompt → dispatch → history → send loop.
3. **Structured error type** in `client.ts`: a `ClientError` discriminated union
   (`{ kind: "http", status, statusText } | { kind: "network", cause }`) instead
   of plain `Error`. `repl.ts` maps kinds to user-facing messages.
4. **Config from env/CLI**: `VISE_BASE_URL`, `VISE_MODEL`, or `--base-url` /
   `--model` flags. `config.ts` validates and merges; no other module reads env.
5. **Streaming**: `chat` gains an `onChunk` callback or returns an `AsyncIterable`.
   The REPL prints chunks as they arrive; history still gets the full message
   appended once on completion.
6. **`system` role**: a `--system` flag or `~/.vise/system.md` file. The client
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
