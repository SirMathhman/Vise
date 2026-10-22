# Architecture

Written for: developers working on this crate.

## Definitions

- **Strata**: a local inference server that exposes an OpenAI-compatible API. This crate expects it at `http://127.0.0.1:8080`. Replies are streamed as server-sent events, and tool calls are streamed as fragments indexed by call.
- **REPL**: the terminal read-eval-print loop in `src/main.rs`. Each line of input is added to the conversation and run as a turn. Reasoning appears under `[thinking]`, tool calls under `[tool]`, then the answer. `exit` or `quit` ends it, and `/new` starts a fresh conversation. It runs when `vise` is started without arguments.
- **Web UI**: a browser page served by `vise web` on `127.0.0.1:3000`. It has the same chat behavior as the REPL. Reasoning appears in a collapsible Thinking block, and tool calls appear as monospace lines in the reply. The page is written in TypeScript and compiled to `web/app.js`.
- **Proxy**: the `/api/chat` route in `src/web.rs`. Strata sends no CORS headers, so the browser calls this same-origin route, and only the Rust server calls Strata. The route runs a turn and relays its events to the browser as server-sent events.
- **Turn**: one user message and everything the model does in response, including any tool rounds. `agent::run_turn` runs it.
- **Session**: the in-memory conversation history in `src/session.rs`. It lasts for one REPL run and is used only by the REPL. The web UI keeps its own copy in the page, which is lost on reload.
- **Message**: one turn in a conversation, a `Role` (`User` or `Assistant`) plus its text. Defined in `src/strata.rs`.
- **Chunk**: one streamed piece of a turn: reasoning text, answer text, or a tool call (`Chunk::Tool`, currently a preformatted `name arguments` string). Defined in `src/strata.rs`.
- **Config**: the server URL, model name, read timeout, and working directory, held in `strata::Config`. It defaults to the local server, the `qwen3.8-flash-next-iq2_xs` model, a 60-second read timeout, and no working directory. `main.rs` reads the current directory once at startup and passes it to both the REPL and the web server. When set, it is sent to the model as a leading system message on each request, and it is not stored in the session history. If the directory cannot be read, a warning is printed once at startup and the model is not told.
- **StrataError**: the error type for a failed call. Its variants are `Network` (no connection), `Timeout` (no bytes within the read timeout), `Http` (non-2xx status), and `Malformed` (unparseable or unexpected response).

## Structure

```
src/
  main.rs     stdin loop, or `web` argument to start the web server
  agent.rs    run_turn: streams a reply, runs requested tools, repeats up to 8 rounds
  tools.rs    tool definitions and run(): list_files, read_file, create_file,
              create_directory, delete_file, and delete_directory
  session.rs  Session: message list with push, pop, reset, and messages (REPL only)
  strata.rs   Config, Role, Message, Chunk, Reply, StrataError, and the streaming client
  web.rs      std TcpListener HTTP server, one thread per connection:
              serves the UI and proxies /api/chat as server-sent events
web/
  index.html  page markup and styles
  src/app.ts  client: reads the event stream and renders reasoning, tool calls, and answer
  app.js      compiled output of app.ts, committed so the server needs no build
  tsconfig.json
package.json  TypeScript and concurrently dev dependencies. Scripts: `build` (tsc -p web),
              `watch:ts` (tsc --watch), `watch:rs` (cargo watch, needs cargo-watch installed),
              and `dev` (runs both together)
```

Dependencies run one way: `main` and `web` call `agent`, `agent` calls `strata` and `tools`, `strata` calls `tools` for the definitions sent with each request, and `session` uses `strata` for `Message`. There are no cycles.

`strata.rs` is split into layers:

- `message_items(messages, config)` converts messages to wire-format items, with the working directory first when set.
- `open_stream(items, config)` builds a `ureq` agent with the configured read timeout, sends the request with the tool definitions, and returns a reader over the response body. Failures before any reply text are reported here.
- `relay(reader, url, on_chunk)` reads server-sent events until `[DONE]`, passes each reasoning and content delta to `on_chunk`, assembles streamed tool-call fragments by index, and returns a `Reply` with the answer text and tool calls.
- `stream_reply(items, config, on_chunk)` is `open_stream` followed by `relay`.
- `request_body(items, config)` builds the JSON body with `stream: true` and the tool definitions. It is pure.
- `build_body(messages, config)` is `request_body` over `message_items`. It is pure, tested, and used only by tests.
- `parse_reply(url, data)` extracts `choices[0].message.content` from a non-streaming response. It is pure, tested, and used only by tests.

`build_request` (a single-message wrapper around `build_body`) also exists only for tests. `build_request`, `build_body`, and `parse_reply` therefore produce `dead_code` warnings in the binary build.

## Compaction

`src/compaction.rs` keeps long conversations within the model's context window. The log is append-only. Messages are never edited or removed, and a summary is appended after a reply once the messages that would be sent reach about 75% of 131072 tokens. The size is estimated as bytes divided by 3, because Vise does not read Strata's token counts.

A request sends the latest summary (as a system message) followed by the messages after it. Messages before that summary are neither sent nor counted. To make the summary, Vise sends those messages again with the request `Summarize this conversation so it can be continued later...` appended at the end, so the prefix stays the same and the prompt cache still applies. A grammar forbids tool calls in that request. An empty or failed summary is reported as a warning and leaves the log unchanged.

The REPL appends the summary to its session. The web server returns it in the `done` event, and the page appends it to its log. A summary entry shows as "Earlier conversation summarized." Both sides therefore keep the same log.

## Tools and the Turn Loop

`agent::run_turn` starts from the session's messages, streams a reply, and if the reply contains tool calls it:

1. Adds the assistant's tool-call item to the working list.
2. Reports each call as a `Chunk::Tool`, runs it with `tools::run`, and adds a `tool` message with the result.
3. Streams the next reply.

When a reply has no tool calls, its answer text is the turn's result. More than 8 rounds in one turn is an error.

`tools::run(name, arguments)` returns the result text for the model. A failed call returns text beginning with `error:`, so the model can recover and the turn continues. `list_files` takes a required `path` and a required `depth` of at least 1. Depth 1 lists only the directory's own entries, and subdirectories end with `/`.

`read_file` takes a required `path`, a required `start`, and a required `end`, all in 1-based lines. `start` is included and `end` is excluded. The result has each line prefixed with its number and a tab. An `end` past the last line is clipped to the file, and a range with no lines is an error. Results over 16 KiB are cut short with a notice asking the model to narrow the range.

The write tools change the disk and run without confirmation:

- `create_file` takes `path` and `content`. It creates a new file with `create_new`, so an existing file is never changed, and the parent directory must already exist.
- `create_directory` takes `path`. It creates the directory and any missing parents, and it fails if the path already exists.
- `delete_file` takes `path`. It refuses directories.
- `delete_directory` takes `path`. It removes only an empty directory, and it refuses files.

All six file tools (the two read tools above and these four) resolve their path with `tools::resolve(root, path, allow_root)` against the working directory. Checks are applied in this order:

1. Absolute paths (`C:\...`, `\...`), network and device paths (`\\host\share`, `//host/share`), and drive-relative paths (`C:foo`) are refused before any filesystem call. Only relative paths continue.
2. The path is joined to the working directory. Each existing component is inspected with `symlink_metadata`, and only "not found" lets the walk move to the parent. Any other error fails the call.
3. The nearest existing ancestor is canonicalized, the missing components are appended, and the result must start with the canonical working directory. This catches `..` and symlinks that point outside.
4. Unless `allow_root` is set, the working directory itself is refused. Only the read tools allow it, so a write or delete can never target the directory.

These checks run when the tool is called. They are not a sandbox: a link created between the check and the operation is not caught. Without a working directory every file tool returns an error.

Tools can be switched off at runtime. `/tools` lists each tool as on or off, `/disable <tool>` switches one off, and `/enable <tool>` switches it back on. The state lives in a `tools::Switches` value, which holds the set of disabled names behind a mutex. `main` creates one and passes it to the REPL, or to `vise web`, where it is shared by every request and kept for the life of that server process. Switching a tool does not change the request prompt. The tool list is always the full list from `tools::definitions()`, and the conversation is not edited. Tool definitions sit at the front of the prompt, so changing them would invalidate the server's prompt cache for the whole conversation. While any tool is switched off, each request also carries a GBNF `grammar` built by `src/grammar.rs`. Strata applies it while decoding, so the model cannot generate a call to a disabled tool. The grammar allows prose that never contains `<tool_call>`, and calls in Strata's XML format with names taken only from the enabled tools. It is sent only while a tool is off, and it does not change the prompt, so the cache still applies. As a backstop, a call to a disabled tool that somehow gets through still returns `error: tool <name> is disabled`.

The model is also told about switch changes. Each conversation keeps the set of switched-off tools the model has been told about: the REPL keeps it in `Session`, and the web page keeps it and sends it with each request as `told`. `tools::note_changes` compares that set with the current switches and, when they differ, prepends a note such as `[Tool status changed: now switched off: delete_file.]` to the next user message. Only the change is sent, so repeated toggles add one note per change. The new set is recorded only after the reply is delivered: the REPL does it after a successful turn, and the web server returns it in the `done` event, which the page keeps only when it arrives. A failed turn therefore leaves the set unchanged, and the change is announced again. `/new` and the web New button clear the set, so a fresh conversation is told every switched-off tool. If a `done` event never arrives, the page keeps the old set and the note is repeated on the next message. The commands are handled in `src/commands.rs`. The REPL handles them before a turn starts, and the web server answers a command in place of a turn. The page keeps commands out of its conversation. Everything is on at startup, and the state is not saved between runs.

Tool exchanges are not stored in the session. Only the user message and the final answer are kept, so later turns do not see earlier tool results.

On a failed turn the REPL pops the user message it just added, so a failed turn does not stay in the history. The web UI does the same with its own copy.

The `done` event carries the turn's final answer, and the web page stores that text as the assistant message. Text from earlier rounds of the turn is shown on screen but not stored, as in the REPL.

`web.rs` limits requests before reading the body: bodies over 1 MiB get 413, and POST `/api/chat` requires `Content-Type: application/json` or it gets 415. Each connection has a 10-second read timeout on the client socket. Each connection is handled on its own thread, so one slow client does not block others. The chat route sends the event-stream headers when the first event is ready. A failure before that is a 502 JSON response.

## Potential Problems

- **Write tools run without confirmation.** The four write tools change files inside the working directory as soon as the model asks. A model error or injected instruction can create or delete files there. The boundary limits the blast radius but does not prevent it.
- **Tool results are capped, but reading is not.** `tools::run` cuts any result over 16 KiB, so one result cannot fill the context. `read_file` still reads the whole file into memory before selecting the range, and `list_files` walks the whole tree to the requested depth, both on the request thread. Depth has no maximum.
- **Tools are limited to the working directory, not to the rest of the machine.** Files under that directory are still readable and changeable by the model, including anything secret stored there. The web server binds to `127.0.0.1` and has no Origin check, which limits exposure but does not remove the risk.
- **Strata read timeout is per read, not per reply.** A reply that keeps producing bytes can run longer than 60 seconds without timing out. Only a stall between bytes trips the timeout.
- **Full history is sent every turn.** There is no cap, so a long session can exceed the model's context window.
- **Config is fixed at startup.** The URL, model, and timeout come from `Config::default()`, so changing them requires a rebuild. The web route uses the config passed at startup. Tool switches are not part of `Config`.
- **Grammar limits.** The grammar refuses to let a tool argument contain `</parameter>`, even where Strata itself would accept it, and it refuses prose that quotes `<tool_call>` while any tool is off. Whitespace is allowed between and after calls. The grammar was checked against Strata's parser with eight fixture cases (prose, calls in prose, two calls with a newline between, disabled names, `<` in a value, quoted `<tool_call>`), but that check is manual, not a test.
- **Grammar-constrained decoding has costs.** While a tool is off, Strata decodes one token at a time with no speculative drafting, and it computes the mask in Python. The grammar also assumes Strata's XML call format and the `<parameter=...>` body. If Strata rejects the grammar (for example with batching on), the turn fails with `GrammarRejected` instead of running without enforcement.
- **Switches are global to the process.** A `/disable` sent to `vise web` by any client changes the tools for every client. The server has no authentication, so this relies on it being bound to `127.0.0.1` only.
- **Ctrl+C is not handled.** The OS default handler ends the process, so the `bye` message is not printed on Ctrl+C.
- **Duplicated turn logic.** History handling and pop-on-error are still implemented separately in `main.rs` and `web/src/app.ts`.
- **Layering.** The wire client knows the tool registry because `request_body` calls `tools::definitions()`. Tool-call wire format is split between `strata.rs` (fragment parsing) and `agent.rs` (building the assistant and tool messages).
- **Error kinds.** Exceeding the tool-round cap is reported as `Malformed`, which reads as an unexpected response from Strata. Tool errors are plain text, not a type.
- **Error handling gaps.** `StrataError` does not implement `std::error::Error`. A failed body read in the `Http` branch is silently replaced with an empty string. The web route maps every Strata error to 502, so the distinction between error kinds is lost there. The `Network` message repeats the URL, because the underlying error text already includes it.
- **Only some errors suggest a next step.** The `Network` and `Timeout` messages do. The `Http` and `Malformed` messages do not.
- **Web UI rollback is partial.** On a failed turn, the web UI drops the user message from its history, but the user message and any partial reply stay on screen. A retry does not include the failed turn in the history, which matches the REPL, but the screen and the history disagree.
- **Non-JSON error bodies** fall back to a generic `HTTP <status>` message in the web UI, which does not say what to do.
- **Dead functions.** `build_request`, `build_body`, and `parse_reply` exist only for tests and produce `dead_code` warnings in the binary build.
- **Web UI race.** The New button stays enabled while a request is in flight. If it is clicked mid-request, the reply lands in a cleared conversation, and a later failure pops the wrong message.
- **Web UI accessibility.** The chat input has no label or placeholder, and the page shows no hint when empty.

## Error Layers

Error text is produced in three places:

- **`StrataError` Display** in `src/strata.rs`. The REPL prints it, and the web server sends it as the 502 JSON body `{"error": ...}` or as the SSE event `{"type": "error", "error": ...}`.
- **`parse_messages`** in `src/web.rs`. It returns the 400 messages for a bad request body.
- **`web/src/app.ts`**. It builds its own messages for an unreachable server, a dropped connection, a reply that ends before `done`, and a non-JSON error response (`HTTP <status>`).

Tool errors are returned to the model as `error:` text and are not shown as errors to the user. Errors cross the wire as text only. The client cannot branch on the kind of error, and the JSON and SSE error shapes are handled by separate code paths in `app.ts`.

## Future Work

1. Decide whether tool results should stay in the history. Today both front ends keep only the user message and the final answer, so the model cannot see earlier tool output in later turns.
2. Cap tool output for both `list_files` and `read_file` by bytes, and cap `list_files` depth and entries. Consider limiting paths to the working directory.
3. Move the tool-call wire format into `strata.rs`, make `Chunk::Tool` carry structured data, and let each front end format it. Pass tool definitions in through `Config` rather than having the client call `tools`.
4. Give tool and turn-loop errors their own types, so the round cap is not reported as a Strata response error.
5. Cap the history sent per request, or drop the oldest turns once it gets long.
6. Read the URL, model, and timeout from environment variables or command-line arguments, keeping `Config` as the injection point.
7. Handle Ctrl+C so the REPL prints `bye` and exits cleanly, for example with the `ctrlc` crate.
8. Implement `std::error::Error` for `StrataError`, stop discarding body-read errors, and let the web route map error kinds to distinct statuses.
9. Disable the New button while a request is in flight, and label the chat input.
10. Dev loop: a TypeScript compile error leaves the server on the previous build with no signal beyond the terminal. Consider live reload. Also check on Windows whether restarting the server leaves the old `vise.exe` holding port 3000, and pin the dev tooling so `npm run dev` fails clearly when cargo-watch is missing.

## Performance

- Replies stream, so text appears as it is generated in both the REPL and the web UI.
- Each web request runs on its own thread. The Strata call blocks only that thread.
- Each request opens a new connection to Strata. Connections are not deliberately reused.
- Each request re-sends the entire session, and each tool round re-sends the whole turn, so request size and latency grow with conversation length and tool output.
- Latency is dominated by model generation on the Strata server, not by this crate. The client adds only JSON encoding and one HTTP round trip per model round.
