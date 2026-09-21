# Vise — Architecture

The ideal architecture this project is working toward. This document points ahead of
the code; it is not a changelog. Progress lives in the git log.

## Definitions

- **Turn** — one user message plus the model's reply to it. A turn is the unit of
  state that accumulates in a conversation.
- **Conversation** — the ordered, in-memory sequence of turns (user + assistant
  messages) sent to the model on every request. It is the REPL's source of truth
  for context.
- **LLM client** — the single module that knows the wire protocol
  (OpenAI-compatible `POST /v1/chat/completions` against llama.cpp). Everything
  else talks to the model through this module and nothing else.
- **Transport** — how stdin is read and how output is rendered (prompts,
  assistant replies, errors). Swappable, and the only module allowed to touch
  `process.stdin`/`process.stdout`.
- **Config** — the typed, env-derived settings object (base URL, model, API key).
  Constructed once at startup; read-only everywhere else.

**Invariant:** the LLM client must never import from the transport, and the
transport must never import from the LLM client. All cross-cutting state
(conversation, config) flows _down_ from the entry point, never sideways
between those two modules.

## Structure

Module layout and dependency direction (each directory/file below is a real,
split-on-demand module — the single-file `index.ts` is the collapsed form of
this graph):

```
index.ts            entry point: build Config, wire Transport + Client + Repl, run
src/config.ts       read env -> typed Config (frozen). No I/O, no fetch.
src/llm/types.ts    Message, ChatMessage, ChatCompletionRequest/Response shapes.
src/llm/client.ts   LLM client: takes Config + messages, returns a structured
                      result. The ONLY place fetch() is called.
src/repl/input.ts   stdin buffering (line queue + nextLine). No fetch, no state.
src/repl/render.ts  prompt/answer/error rendering. Pure formatting.
src/repl/loop.ts    the turn loop: glue between input, conversation, client,
                      render.
```

Dependency direction: `index -> src/repl/loop -> (src/repl/input, src/repl/render,
src/llm/client) -> src/llm/types, src/config`. `src/llm/*` and `src/repl/*` do not
import each other. `src/config.ts` and `src/llm/types.ts` are leaves.

Enforcement: the `bun lint` script (Biome) enforces what it can; the rest
(function/file/directory line limits — 100/500/10 — is caught by this review and
by the madge-style dependency check below).

Dependency check: `madge --extensions ts src/ index.ts` must show no cycles.
Run it in CI or as part of `bun lint` before it matters.

## Potential Problems

- **Unbounded conversation.** `messages` grows linearly with turns; every request
  re-sends the whole history, so a long session is O(n^2) tokens total and will
  eventually exceed the model's context window (the server returns an error
  rather than truncating). Watch for: 400/413-style errors from llama.cpp on
  long sessions. The fix is a bounded window (keep last N messages or tokens)
  owned by `loop.ts`, not by `client.ts`.
- **No retry or timeout on `fetch`.** A hung llama.cpp server blocks the REPL
  forever; a transient ECONNREFUSED is reported as a generic error. The client
  should have a `signal`/timeout and a distinguishable "server unreachable"
  error.
- **Hard `process.exit(0)` at shutdown.** Any finally-block cleanup or future
  teardown (e.g., flushing a session log) is skipped. Prefer letting the event
  loop drain; keep `process.exit` as a last resort for a stuck loop.
- **Errors are opaque strings.** `Error("HTTP 404: ...")` does not say what
  caused it or what to do. The client should return a structured result
  (`Ok | HttpError | NetworkError`) that answers: what, where, why, fix.
- **Config defaults mask misconfiguration.** `LLM_BASE_URL ?? "http://localhost:8080"`
  silently falls back; a missing `.env.local` produces a confusing network
  error rather than "config missing." Prefer a loud startup check.

## Future Work

- **Streaming responses.** `stream: true` + SSE parsing in `client.ts` so the
  user sees tokens as they arrive; `render.ts` gains an append mode. The
  conversation still accumulates the full reply before the next turn.
- **Command surface.** Lines beginning with `/` (e.g., `/reset` to clear the
  conversation, `/model` to inspect config) handled in `loop.ts` before they
  reach the client.
- **Session persistence.** Serialize the conversation to disk so a crash or
  Ctrl-C does not lose context; the transport stays oblivious.
- **Tests.** Unit tests for `input.ts` (line buffering), `client.ts` (against a
  mocked `fetch`), and `loop.ts` (conversation accumulation). These are the
  seams that make the module split above safe to execute.

## Performance

Obvious concerns only — profile before optimizing.

- **Perceived latency:** the full reply is awaited before any output; streaming
  (Future Work) is the real fix, not a micro-optimization.
- **Token cost:** re-sending full history every turn doubles the tokens per
  added turn; the bounded window is the fix and is also a correctness issue.
- **Memory:** the line buffer is bounded by input; the conversation is bounded
  only by the model's context window, not by the process.
