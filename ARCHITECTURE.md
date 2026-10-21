# Architecture

Written for: developers working on this crate.

## Definitions

- **Strata**: a local inference server that exposes an OpenAI-compatible API. This crate expects it at `http://127.0.0.1:8080`.
- **REPL**: the read-eval-print loop in `src/main.rs`. Each line of input is added to the conversation, sent to Strata, and the reply is printed. `exit` or `quit` ends it, and `/new` starts a fresh conversation.
- **Session**: the in-memory conversation history in `src/session.rs`. It lasts for one run of the REPL and is lost on exit.
- **Message**: one turn in a conversation, a `Role` (`User` or `Assistant`) plus its text. Defined in `src/strata.rs`.
- **Config**: the server URL and model name, held in `strata::Config`. It defaults to the local server and the `qwen3.8-flash-next-iq2_xs` model.
- **StrataError**: the error type for a failed call. Its variants are `Network` (no connection), `Http` (non-2xx status), and `Malformed` (response body without the expected reply).

## Structure

```
src/
  main.rs     stdin loop: prompt, read a line, handle exit/quit/empty/"/new",
              send the session, print the reply or error
  session.rs  Session: message list with push, pop, reset, and messages
  strata.rs   Config, Role, Message, StrataError, and the chat-completions client
```

`strata.rs` is split into three layers:

- `build_body(messages, config)` builds the JSON body from the full conversation. It is pure.
- `parse_reply(url, data)` extracts `choices[0].message.content`. It is pure.
- `send_message(messages, config)` performs the HTTP POST with `ureq` and maps transport and status failures to `StrataError`.

Only `send_message` touches the network. `parse_reply` and `build_request` have unit tests in `strata.rs` that need no server. `build_request` is a single-message wrapper around `build_body` and is currently used only by tests. `build_body` is not tested directly.

On a failed request, `main.rs` pops the user message it just added, so a failed turn does not stay in the history.

## Potential Problems

- **No HTTP timeout.** `ureq` runs with defaults, so a hung Strata server blocks the REPL indefinitely.
- **Full history is sent every turn.** There is no cap, so a long session can exceed the model's context window (131072 tokens for this model).
- **Config is compile-time only.** The URL and model come from `Config::default()`, so changing them requires a rebuild.
- **Ctrl+C is not handled.** The OS default handler ends the process, so the `bye` message is not printed on Ctrl+C.
- **Error handling gaps.** `StrataError` does not implement `std::error::Error`. A failed body read in the `Http` branch is silently replaced with an empty string. The `Network` message repeats the URL, because the underlying error text already includes it.
- **Only the `Network` error suggests a next step.** The `Http` and `Malformed` messages do not.
- **Dead function.** `build_request` exists only for tests and produces a `dead_code` warning in the binary build.

## Future Work

1. Add a request timeout to the `ureq` call and report it as a distinct error.
2. Cap the history sent per request, or drop the oldest turns once it gets long.
3. Read the URL and model from environment variables or command-line arguments in `main`, keeping `Config` as the injection point.
4. Handle Ctrl+C so the REPL prints `bye` and exits cleanly, for example with the `ctrlc` crate.
5. Implement `std::error::Error` for `StrataError` and stop discarding body-read errors.

## Performance

- Each request blocks the REPL until the full reply arrives. The server does not stream, so no partial output is shown.
- The `ureq::post` call uses the default agent for each request. Connections are not deliberately reused, so each line opens a new connection to localhost.
- Each request re-sends the entire session, so request size and latency grow with conversation length.
- Latency is dominated by model generation on the Strata server, not by this crate. The client adds only JSON encoding and one HTTP round trip.
