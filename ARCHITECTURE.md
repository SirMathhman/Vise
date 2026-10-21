# Architecture

Written for: developers working on this crate.

## Definitions

- **Strata**: a local inference server that exposes an OpenAI-compatible API. This crate expects it at `http://127.0.0.1:8080`.
- **REPL**: the terminal read-eval-print loop in `src/main.rs`. Each line of input is added to the conversation, sent to Strata, and the reply is printed. `exit` or `quit` ends it, and `/new` starts a fresh conversation. It runs when `vise` is started without arguments.
- **Web UI**: a browser page served by `vise web` on `127.0.0.1:3000`. It has the same chat behavior as the REPL. The page is written in TypeScript and compiled to `web/app.js`.
- **Proxy**: the `/api/chat` route in `src/web.rs`. Strata sends no CORS headers, so the browser calls this same-origin route, and only the Rust server calls Strata.
- **Session**: the in-memory conversation history in `src/session.rs`. It lasts for one REPL run. The web UI keeps its own copy in the page, which is lost on reload.
- **Message**: one turn in a conversation, a `Role` (`User` or `Assistant`) plus its text. Defined in `src/strata.rs`.
- **Config**: the server URL and model name, held in `strata::Config`. It defaults to the local server and the `qwen3.8-flash-next-iq2_xs` model.
- **StrataError**: the error type for a failed call. Its variants are `Network` (no connection), `Http` (non-2xx status), and `Malformed` (response body without the expected reply).

## Structure

```
src/
  main.rs     stdin loop, or `web` argument to start the web server
  session.rs  Session: message list with push, pop, reset, and messages
  strata.rs   Config, Role, Message, StrataError, and the chat-completions client
  web.rs      std TcpListener HTTP server: serves the UI and proxies /api/chat
web/
  index.html  page markup and styles
  src/app.ts  client: sends the conversation to /api/chat and renders replies
  app.js      compiled output of app.ts, committed so the server needs no build
  tsconfig.json
package.json  TypeScript dev dependency and `build` script (tsc -p web)
```

`strata.rs` is split into three layers:

- `build_body(messages, config)` builds the JSON body from the full conversation. It is pure.
- `parse_reply(url, data)` extracts `choices[0].message.content`. It is pure.
- `send_message(messages, config)` performs the HTTP POST with `ureq` and maps transport and status failures to `StrataError`.

Only `send_message` touches the network. `parse_reply` and `build_request` have unit tests in `strata.rs` that need no server. `build_request` is a single-message wrapper around `build_body` and is currently used only by tests. `build_body` is not tested directly.

On a failed request, the REPL pops the user message it just added, so a failed turn does not stay in the history. The web UI does the same with its own copy.

`web.rs` limits requests before reading the body: bodies over 1 MiB get 413, and POST `/api/chat` requires `Content-Type: application/json` or it gets 415. Each connection has a 10-second read timeout.

## Potential Problems

- **Requests are handled one at a time.** A slow or stalled client delays every other request to the web server.
- **No timeout on the Strata call.** `ureq` runs with defaults, so a hung Strata server blocks the REPL and the web server.
- **Full history is sent every turn.** There is no cap, so a long session can exceed the model's context window (131072 tokens for this model).
- **Config is compile-time only.** The URL and model come from `Config::default()`, so changing them requires a rebuild. The web route calls it per request.
- **Ctrl+C is not handled.** The OS default handler ends the process, so the `bye` message is not printed on Ctrl+C.
- **Error handling gaps.** `StrataError` does not implement `std::error::Error`. A failed body read in the `Http` branch is silently replaced with an empty string. The web route maps every Strata error to 502, so the distinction between error kinds is lost there. The `Network` message repeats the URL, because the underlying error text already includes it.
- **Only the `Network` error suggests a next step.** The `Http` and `Malformed` messages do not.
- **Dead function.** `build_request` exists only for tests and produces a `dead_code` warning in the binary build.
- **Web UI race.** The New button stays enabled while a request is in flight. If it is clicked mid-request, the reply lands in a cleared conversation, and a later failure pops the wrong message.
- **Web UI accessibility.** The chat input has no label, and the page shows no hint when empty.

## Future Work

1. Add a request timeout to the `ureq` call and report it as a distinct error.
2. Handle connections concurrently in the web server, for example a thread per connection or a small worker pool.
3. Cap the history sent per request, or drop the oldest turns once it gets long.
4. Read the URL and model from environment variables or command-line arguments, keeping `Config` as the injection point.
5. Handle Ctrl+C so the REPL prints `bye` and exits cleanly, for example with the `ctrlc` crate.
6. Implement `std::error::Error` for `StrataError`, stop discarding body-read errors, and let the web route map error kinds to distinct statuses.
7. Disable the New button while a request is in flight, and label the chat input.

## Performance

- Each request blocks until the full reply arrives. The server does not stream, so no partial output is shown in either the REPL or the web UI.
- The `ureq::post` call uses the default agent for each request. Connections are not deliberately reused, so each request opens a new connection to localhost.
- Each request re-sends the entire session, so request size and latency grow with conversation length.
- Latency is dominated by model generation on the Strata server, not by this crate. The client adds only JSON encoding and one HTTP round trip.
