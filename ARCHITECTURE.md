# Architecture

Written for: developers working on this crate.

## Definitions

- **Strata**: a local inference server that exposes an OpenAI-compatible API. This crate expects it at `http://127.0.0.1:8080`. Replies are streamed as server-sent events, and tool calls are streamed as fragments indexed by call.
- **REPL**: the terminal read-eval-print loop in `src/main.rs`. Each line of input is added to the conversation and run as a turn. Reasoning appears under `[thinking]`, tool calls under `[tool]`, then the answer. `exit` or `quit` ends it, and `/new` starts a fresh conversation. Ctrl+C stops a running reply, and a second Ctrl+C quits. It runs when `vise` is started without arguments.
- **Web UI**: a browser page served by `vise web` on `127.0.0.1:3000`. It has the same chat behavior as the REPL. Reasoning appears in a collapsible Thinking block, and tool calls appear as monospace lines in the reply. The page is written in TypeScript and compiled to `web/app.js`.
- **Proxy**: the `/api/chat` route in `src/web.rs`. Strata sends no CORS headers, so the browser calls this same-origin route, and only the Rust server calls Strata. The route runs a turn and relays its events to the browser as server-sent events.
- **Turn**: one user message and everything the model does in response, including any tool rounds. `agent::run_turn` runs it.
- **Session**: the in-memory conversation history in `src/session.rs`. It lasts for one REPL run and is used only by the REPL. The web UI keeps its own copy in the page, which is lost on reload.
- **Message**: one turn in a conversation, a `Role` (`User`, `Assistant`, `Summary`, or `SummaryFailed`) plus its text. Defined in `src/strata.rs`.
- **Chunk**: one streamed piece of a turn: reasoning text, answer text, or a tool call (`Chunk::Tool`, currently a preformatted `name arguments` string). Defined in `src/strata.rs`.
- **Config**: the server URL, model name, read timeout, and working directory, held in `strata::Config`. It defaults to the local server, the `qwen3.8-flash-next-iq2_xs` model, a 60-second read timeout, and no working directory. `main.rs` reads the current directory once at startup and passes it to both the REPL and the web server. When set, it is sent to the model as a leading system message on each request, and it is not stored in the session history. If the directory cannot be read, a warning is printed once at startup and the model is not told.
- **StrataError**: the error type for a failed call to Strata. Its variants are `Network` (no connection), `Timeout` (no bytes within the read timeout), `Http` (non-2xx status), `Malformed` (unparseable or unexpected response), `GrammarRejected` (Strata refused the grammar), and `Stopped` (the stream was cancelled).
- **TurnError**: the error type for a turn that did not finish, in `src/agent.rs`. `Stopped` means the user stopped it; `Failed` wraps a `StrataError`. The round limit is reported as a `Malformed` error, which the doc does not yet treat as its own kind. Both carry `ran`, the tool calls that ran before the failure, as `name arguments` strings.

## Structure

```
src/
  main.rs     stdin loop, or `web` argument to start the web server
  agent.rs    run_turn: streams a reply, runs requested tools, repeats up to 8 rounds
  tools.rs    tool definitions and run(): list_files, read_file, create_file,
              create_directory, delete_file, and delete_directory, plus the note tools
  notes.rs    note tools and the /notes and /note commands: Markdown notes in .vise/notes/<category>/<name>.md
  workspace.rs  leaf helpers shared by the file and note tools: resolve (path confinement), string_arg,
              line_range, and read_range
  session.rs  Session: message list and the told set, with push, pop, reset, messages, told, and set_told (REPL only)
  compaction.rs  after_turn, needs_summary, and summarize: append-only summaries of long conversations
  grammar.rs  the GBNF grammars that block calls to disabled tools: enabled_calls_only (the whole output,
              used when Strata has no lazy grammars) and enabled_calls_after_trigger (a call-only grammar that
              Strata starts at a <tool_call> token)
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

Dependencies run one way: `main` and `web` call `agent`. `agent` calls `strata`, `tools`, and `compaction`. `compaction` calls `strata` and `grammar`. `strata` calls `tools` for the definitions. `tools` calls `notes`. `notes` and `tools` both call `workspace`, which is a leaf and calls nothing else in the crate. `session` uses `strata` for `Message`. There are no cycles.

`strata.rs` is split into layers:

- `message_items(messages, config)` converts messages to wire-format items, with the working directory first when set.
- `open_stream(items, config, constraint)` builds a `ureq` agent with the configured read timeout, sends the request with the tool definitions, and returns a reader over the response body. Failures before any reply text are reported here.
- `relay(reader, url, cancel, on_chunk)` reads server-sent events until `[DONE]`, checks `cancel` before each line, passes each reasoning and content delta to `on_chunk`, assembles streamed tool-call fragments by index, and returns a `Reply` with the answer text and tool calls.
- `stream_reply(items, config, constraint, cancel, on_chunk)` is `open_stream` followed by `relay`. `constraint` is an optional `Constraint { grammar, lazy }`; a lazy one is sent with `grammar_lazy` and a `<tool_call>` token trigger. Whether Strata supports lazy grammars is read once at startup from `/v1/status` (`Config::lazy_grammar`).
- `request_body(items, config, grammar)` builds the JSON body with `stream: true`, the tool definitions, and the grammar when one is given. It is pure.
- `build_body(messages, config)` is `request_body` over `message_items`. It is pure, tested, and used only by tests.
- `parse_reply(url, data)` extracts `choices[0].message.content` from a non-streaming response. It is pure, tested, and used only by tests.

`build_request` (a single-message wrapper around `build_body`) also exists only for tests. `build_request`, `build_body`, and `parse_reply` therefore produce `dead_code` warnings in the binary build.

## Compaction

`src/compaction.rs` keeps long conversations within the model's context window. The log is append-only. Messages are never edited or removed, and a summary is appended after a reply once the messages that would be sent reach about 75% of 131072 tokens. The size is estimated as bytes divided by 3, because Vise does not read Strata's token counts.

A request sends the latest summary (as a system message) followed by the messages after it. Messages before that summary are neither sent nor counted. To make the summary, Vise sends those messages again with the request `Summarize this conversation so it can be continued later...` appended at the end, so the prefix stays the same and the prompt cache still applies. A grammar forbids tool calls in that request. A failed summary is appended as a `SummaryFailed` entry. That entry is never sent to the model, and a new attempt waits until ten more messages have been added.

Compaction also runs inside a turn. Before every model request, including the first, `agent::run_turn` checks the turn's working items. This check measures content and tool-call arguments, the same way as the log check. If the items are too large, the model summarizes them (`compaction::summarize_turn`), and the working items are replaced by the leading system items, that summary, and a prompt to continue (`compaction::continue_turn`). The summary replaces the current user message as well as the tool work, so the task survives only as the summary. Within one round, once the turn is over the threshold, the calls still left in that round return an error instead of running, which keeps the overshoot to one round. A round can still exceed the threshold before the check, and the turn summary is not logged. A failed turn summary fails the turn, and the log is untouched.

The REPL appends the summary to its session. The web server returns it in the `done` event (as `summary`, or as `summary_failed` with the reason when it failed), and the page appends the matching entry to its log. A summary entry shows as "Earlier conversation summarized." Both sides therefore keep the same log.

## Tools and the Turn Loop

`agent::run_turn` starts from the session's messages, streams a reply, and if the reply contains tool calls it:

1. Adds the assistant's tool-call item to the working list.
2. Reports each call as a `Chunk::Tool`, runs it with `tools::run`, and adds a `tool` message with the result.
3. Streams the next reply.

When a reply has no tool calls, its answer text is the turn's result. More than 8 rounds in one turn is an error.

A turn can be stopped. `run_turn` takes a cancel flag, which the turn checks before each round, each tool call, and each line of the stream. Returning from the stream reader drops the connection, so Strata stops generating. Every failure of a turn is a `TurnError` whose `ran` lists the tool calls that ran before it, including network errors, timeouts, and the round limit. Their effects on disk remain, although the turn is not kept, so the REPL and the web error message report them. A tool that is already running finishes before a stop takes effect, and a call that was announced but stopped before it ran is not listed. In the REPL, Ctrl+C sets the flag while a turn runs, and a second Ctrl+C quits. In the web UI, the Stop button aborts the request, and the server cannot send the list after an abort, so the page only says that the calls shown above may have run. A write that fails because the page went away also sets the flag.

`tools::run(name, arguments, root)` returns the result text for the model. A failed call returns text beginning with `error:`, so the model can recover and the turn continues. `list_files` takes a required `path` and a required `depth` of at least 1. Depth 1 lists only the directory's own entries, and subdirectories end with `/`.

`read_file` takes a required `path`, a required `start`, and a required `end`, all in 1-based lines. `start` is included and `end` is excluded. The result has each line prefixed with its number and a tab. An `end` past the last line is clipped to the file, and a range with no lines is an error. Results over 16 KiB are cut short with a notice asking the model to narrow the range.

The write tools change the disk and run without confirmation:

- `create_file` takes `path` and `content`. It creates a new file with `create_new`, so an existing file is never changed, and the parent directory must already exist.
- `create_directory` takes `path`. It creates the directory and any missing parents, and it fails if the path already exists.
- `delete_file` takes `path`. It refuses directories.
- `delete_directory` takes `path`. It removes only an empty directory, and it refuses files.

The note tools keep Markdown notes at `.vise/notes/<category>/<name>.md` under the working directory. They live in `src/notes.rs`:

- `list_notes` takes no arguments and lists every note as `category/name`.
- `read_note` takes `category`, `name`, `start` and `end`, and reads lines the same way as `read_file`.
- `create_note` takes `category`, `name` and `content`. It fails if the note exists, and it creates the category directory when needed.
- `edit_note` takes `category`, `name`, `old` and `new`. It replaces `old` only when `old` occurs exactly once in the note.
- `delete_note` takes `category` and `name`.

`category` and `name` may use only letters, digits, `-` and `_`, so a note cannot leave `.vise/notes`. Notes are not added to the prompt. The model sees a note only when it reads it. The user's `/notes` and `/note` commands use the same checks.

Every file tool and note tool resolves its path with `tools::resolve(root, path, allow_root)` against the working directory. Checks are applied in this order:

1. Absolute paths (`C:\...`, `\...`), network and device paths (`\\host\share`, `//host/share`), and drive-relative paths (`C:foo`) are refused before any filesystem call. Only relative paths continue.
2. The path is joined to the working directory. Each existing component is inspected with `symlink_metadata`, and only "not found" lets the walk move to the parent. Any other error fails the call.
3. The nearest existing ancestor is canonicalized, the missing components are appended, and the result must start with the canonical working directory. This catches `..` and symlinks that point outside.
4. Unless `allow_root` is set, the working directory itself is refused. Only the read tools allow it, so a write or delete can never target the directory.

These checks run when the tool is called. They are not a sandbox: a link created between the check and the operation is not caught. Without a working directory every file tool returns an error.

Tools can be switched off at runtime, per session. `/tools` lists each tool as on or off, `/disable <tool>` switches one off, and `/enable <tool>` switches it back on. A session is one REPL process, or one browser tab. The REPL's `Switches` belong to its process. Each web tab keeps a random session id in `sessionStorage` and sends it with every chat request, and `web::Sessions` maps each id to its own `Switches`, so a `/disable` in one tab never changes another tab, even when they run at the same time. A tab's switches last for the life of the web server process; a reload of the same tab keeps them. The set is shared only through a mutex on the map and on each session's set, which are locked briefly and never across I/O. Each model round takes one snapshot of the session's switches, which decides both the tools offered in the request and the refusal check, so they agree. Switching a tool does not change the request prompt. The tool list is always the full list from `tools::definitions()`, and the conversation is not edited. Tool definitions sit at the front of the prompt, so changing them would invalidate the server's prompt cache for the whole conversation. While any tool is switched off, each request also carries a GBNF `grammar` built by `src/grammar.rs`, and Strata applies it while decoding, so the model cannot generate a call to a disabled tool. When Strata supports lazy grammars, the grammar is lazy: it is idle until the model starts a call with `<tool_call>`, so prose and reasoning are not constrained. The grammar allows calls in Strata's XML format, with names taken only from the enabled tools. It is sent only while a tool is off, and it does not change the prompt, so the cache still applies. As a backstop, a call to a disabled tool that somehow gets through still returns `error: tool <name> is disabled`.

The model is also told about switch changes. Each conversation keeps the set of switched-off tools the model has been told about: the REPL keeps it in `Session`, and the web page keeps it and sends it with each request as `told`. `tools::note_changes` compares that set with the current switches and, when they differ, prepends a note such as `[Tool status changed: now switched off: delete_file.]` to the next user message. Only the change is sent, so repeated toggles add one note per change. The new set is recorded only after the reply is delivered: the REPL does it after a successful turn, and the web server returns it in the `done` event, which the page keeps only when it arrives. A failed turn therefore leaves the set unchanged, and the change is announced again. `/new` and the web New button clear the set, so a fresh conversation is told every switched-off tool. If a `done` event never arrives, the page keeps the old set and the note is repeated on the next message. The commands are handled in `src/commands.rs`. The REPL handles them before a turn starts, and the web server answers a command in place of a turn. The page keeps commands out of its conversation. Everything is on at startup, and the state is not saved between runs.

Tool exchanges are not stored in the session. Only the user message and the final answer are kept, so later turns do not see earlier tool results.

On a failed turn the REPL pops the user message it just added, so a failed turn does not stay in the history. The web UI does the same with its own copy.

The `done` event carries the turn's final answer, and the web page stores that text as the assistant message. Text from earlier rounds of the turn is shown on screen but not stored, as in the REPL.

`web.rs` limits requests before reading the body: bodies over 1 MiB get 413, and POST `/api/chat` requires `Content-Type: application/json` or it gets 415. Each connection has a 10-second read timeout on the client socket. Each connection is handled on its own thread, so one slow client does not block others. The chat route sends the event-stream headers when the first event is ready. A failure before that is a 502 JSON response.

## Potential Problems

- **Write tools run without confirmation.** The four write tools change files inside the working directory as soon as the model asks. A model error or injected instruction can create or delete files there. The boundary limits the blast radius but does not prevent it.
- **Tool results are capped, but reading is not.** `tools::run` cuts any result over 16 KiB, so one result cannot fill the context. `read_file` and `read_note` still read the whole file into memory before selecting the range, and `list_files` walks the whole tree to the requested depth, both on the request thread. Depth has no maximum.
- **Tools are limited to the working directory, not to the rest of the machine.** Files under that directory are still readable and changeable by the model, including anything secret stored there. The web server binds to `127.0.0.1` and has no Origin check, which limits exposure but does not remove the risk.
- **Strata read timeout is per read, not per reply.** A reply that keeps producing bytes can run longer than 60 seconds without timing out. Only a stall between bytes trips the timeout.
- **Compaction is estimated and runs after the reply.** The size is estimated from bytes, not Strata's real token counts, and the check runs after a turn finishes, so a single turn can still overflow the window. A failed summary is recorded in the log and retried only after ten more messages.
- **Config is fixed at startup.** The URL, model, and timeout come from `Config::default()`, so changing them requires a rebuild. The web route uses the config passed at startup. Tool switches are not part of `Config`.
- **Grammar limits.** The grammar refuses to let a tool argument contain `</parameter>`, even where Strata itself would accept it, and it refuses prose that quotes `<tool_call>` while any tool is off. Whitespace is allowed between and after calls. The grammar was checked against Strata's parser with eight fixture cases (prose, calls in prose, two calls with a newline between, disabled names, `<` in a value, quoted `<tool_call>`), but that check is manual, not a test.
- **Grammar enforcement depends on Strata's grammar support.** When Strata reports lazy grammars (`/v1/status` `grammar.lazy`, read once at startup into `Config::lazy_grammar`), Vise sends `grammar::enabled_calls_after_trigger` with `grammar_lazy` and a `<tool_call>` token trigger, so prose and reasoning are unconstrained and the grammar starts at the first call. Older builds, or every tool off, get the full-output `enabled_calls_only` grammar. Strata keeps speculative drafting on under a grammar when its engine reports `constrain_rows=1`, so constrained turns run near unconstrained speed once Strata's mask cache is warm; the first request per grammar builds masks and is slower. The grammar assumes Strata's XML call format and the `<parameter=...>` body. If Strata rejects it, the turn fails with `GrammarRejected` instead of running without enforcement.
- **Switches are per session, but the session table is unbounded.** Each web tab's switches are kept until the server process exits, and nothing evicts them. Each entry is small, but a client that sends many session ids grows the table without limit.
- **Ctrl+C at the prompt quits without printing `bye`.** While a turn runs, Ctrl+C stops the turn instead (see Tools and the Turn Loop). A second Ctrl+C, or a press at the prompt, exits the process directly.
- **Duplicated turn logic.** History handling and pop-on-error are still implemented separately in `main.rs` and `web/src/app.ts`.
- **Layering.** The wire client knows the tool registry because `request_body` calls `tools::definitions()`. Tool-call wire format is split between `strata.rs` (fragment parsing) and `agent.rs` (building the assistant and tool messages).
- **Error kinds.** Exceeding the tool-round cap is reported as `Malformed`, which reads as an unexpected response from Strata. Tool errors are plain text, not a type.
- **Stopping waits for a line.** A stop takes effect at the next line Strata sends, not the instant it is pressed. Strata sends text steadily while it generates, so this is short, but a model that is silent for a long time delays the stop until its read timeout or its next output. `StrataError` does not implement `std::error::Error`. A failed body read in the `Http` branch is silently replaced with an empty string. The web route maps every Strata error to 502, so the distinction between error kinds is lost there. The `Network` message repeats the URL, because the underlying error text already includes it.
- **Only some errors suggest a next step.** The `Network` and `Timeout` messages do. The `Http` and `Malformed` messages do not.
- **Web UI rollback is partial.** On a failed turn, the web UI drops the user message from its history, but the user message and any partial reply stay on screen. A retry does not include the failed turn in the history, which matches the REPL, but the screen and the history disagree.
- **Non-JSON error bodies** fall back to a generic `HTTP <status>` message in the web UI, which does not say what to do.
- **Dead functions.** `build_request`, `build_body`, and `parse_reply` exist only for tests and produce `dead_code` warnings in the binary build.
- **Web UI race.** The New button stays enabled while a request is in flight. If it is clicked mid-request, the reply lands in a cleared conversation, and a later failure pops the wrong message.
- **Web UI accessibility.** The chat input has no label or placeholder, and the page shows no hint when empty.

## Error Layers

Error text is produced in three places:

- **`StrataError` Display** in `src/strata.rs`. The REPL prints it, and the web server sends it as the 502 JSON body `{"error": ..., "ran": [...]}` or as the SSE event `{"type": "error", "error": ..., "ran": [...]}`, where `ran` lists the tool calls that ran before the failure.
- **`parse_messages`** in `src/web.rs`. It returns the 400 messages for a bad request body.
- **`web/src/app.ts`**. It builds its own messages for an unreachable server, a dropped connection, a reply that ends before `done`, and a non-JSON error response (`HTTP <status>`).

Tool errors are returned to the model as `error:` text and are not shown as errors to the user. Errors cross the wire as text only. The client cannot branch on the kind of error, and the JSON and SSE error shapes are handled by separate code paths in `app.ts`.

## Security Concerns

Trust boundaries. Four inputs are untrusted: the user's typed messages (trusted in intent, not in content), the text of files the tools read, the arguments the model writes for tool calls, and the bodies of HTTP requests to `vise web`. The model is not a trust boundary: anything it reads from a file, a listing, or a web page can steer its next tool call, so it can carry injected instructions into the tools.

Controls the architecture should have, and their status:

- **Confinement of file tools.** Every path is resolved against the working directory and must stay inside it after canonicalization. Absolute, network, device, and drive-relative paths are refused before any filesystem call, and the working directory itself cannot be written or deleted. Status: in place (`tools::resolve`). Gap: the check and the operation are separate calls, so a link created between them is not caught, and confinement is only as wide as the working directory.
- **Notes are reachable through the file tools.** Notes live under `.vise/notes`, inside the working directory, so `list_files`, `read_file`, `create_file`, and `delete_file` can read, create, or delete them, including names the note tools would refuse. Status: not restricted. Reserving `.vise` from the file tools would close this, but it is a policy change the file tools do not yet make. Notes are also text the model later reads back into its context, so a note can carry injected instructions into a later turn.
- **Confirmation for destructive actions.** Deletes and overwrites should need the user's approval, or at least a visible trail the user can review. Status: missing. `create_file` refuses existing paths, and `delete_directory` removes only empty directories, but no tool asks the user first.
- **Separation of data from instructions.** Tool results, file contents, and listings should reach the model marked as data it must not follow as instructions. Status: missing. Results are plain tool messages, and the model has no marker that they are untrusted.
- **Authentication of the web server.** Anyone who can reach `vise web` can change a tab's switches, read its id from its requests, or send messages as that tab. Status: missing. It relies on binding to `127.0.0.1`. Session ids are random but are not secrets from other local software.
- **Origin and Host checks on the web server.** A page on another origin cannot read responses, because the server sends no CORS headers, and a JSON POST needs a preflight it does not answer. A DNS-rebinding page could still reach the server, since the `Host` header is not checked. Status: partly in place (`text/plain` POSTs are refused with 415); the `Host` check is missing.
- **Bounded resource use.** Request bodies are capped at 1 MiB, and each connection has a 10-second read timeout. Status: partly in place. Missing: a limit on concurrent connections (each connection gets a thread), a depth limit on `list_files`, and a limit on the bytes `read_file` loads from disk. Tool results are capped at 16 KiB before they reach the model.
- **Minimal exposure of content.** Only what a request needs should leave the process. Status: partly in place. The working directory's path is sent to the model, and compaction sends conversation text, including file contents the tools returned, to Strata. Strata is local, so this stays on the machine, but it is still exposure.
- **Grammar is not a security boundary.** Constrained decoding steers what the model writes; it does not enforce policy by itself. The tool switches rely on it together with the call-time refusal, and that refusal is the backstop. Status: in place as a design rule.

## Future Work

1. Decide whether tool results should stay in the history. Today both front ends keep only the user message and the final answer, so the model cannot see earlier tool output in later turns.
2. Cap tool output for both `list_files` and `read_file` by bytes, and cap `list_files` depth and entries. Consider limiting paths to the working directory.
3. Move the tool-call wire format into `strata.rs`, make `Chunk::Tool` carry structured data, and let each front end format it. Pass tool definitions in through `Config` rather than having the client call `tools`.
4. Make tool errors typed, and carry `ran` as structured tool runs rather than preformatted strings, as `Chunk::Tool` does.
5. Read the URL, model, and timeout from environment variables or command-line arguments, keeping `Config` as the injection point.
6. Print `bye` when Ctrl+C quits the REPL at the prompt, as the normal exit does (Ctrl+C during a turn already stops the turn).
7. Implement `std::error::Error` for `StrataError`, stop discarding body-read errors, and let the web route map error kinds to distinct statuses.
8. Disable the New button while a request is in flight (Stop is already shown in its place), and label the chat input.
9. Dev loop: a TypeScript compile error leaves the server on the previous build with no signal beyond the terminal. Consider live reload. Also check on Windows whether restarting the server leaves the old `vise.exe` holding port 3000, and pin the dev tooling so `npm run dev` fails clearly when cargo-watch is missing.

## Performance

- Replies stream, so text appears as it is generated in both the REPL and the web UI.
- Each web request runs on its own thread. The Strata call blocks only that thread.
- Each request opens a new connection to Strata. Connections are not deliberately reused.
- Requests send the latest summary and the messages after it, so their size is bounded by the compaction threshold plus one round. Each tool round re-sends the whole turn, so latency still grows with tool output.
- Latency is dominated by model generation on the Strata server, not by this crate. The client adds only JSON encoding and one HTTP round trip per model round.
