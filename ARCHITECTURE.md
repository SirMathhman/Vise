# Architecture

Written for: developers working on this crate.

## Definitions

- **Strata**: a local inference server that exposes an OpenAI-compatible API. This crate expects it at `http://127.0.0.1:8080`. Replies are streamed as server-sent events, and tool calls are streamed as fragments indexed by call.
- **REPL**: the terminal read-eval-print loop in `src/main.rs`. Each line of input is added to the conversation and run as a turn. Reasoning appears under `[thinking]`, tool calls under `[tool]`, then the answer. `exit` or `quit` ends it, and `/new` starts a fresh conversation. Ctrl+C stops a running reply, and a second Ctrl+C quits. It runs when `vise` is started without arguments.
- **Web UI**: a browser page served by `vise web` on `127.0.0.1:3000`. It has the same chat behavior as the REPL. Reasoning appears in a collapsible Thinking block, and tool calls appear as monospace lines in the reply. The page is written in TypeScript and compiled to `web/app.js`.
- **Proxy**: the `/api/chat` route in `src/web/mod.rs`. Strata sends no CORS headers, so the browser calls this same-origin route, and only the Rust server calls Strata. The route runs a turn and relays its events to the browser as server-sent events.
- **Turn**: one user message and everything the model does in response, including any tool rounds. `agent::run_turn` runs it.
- **Session**: the in-memory conversation history in `src/session.rs`. It lasts for one REPL run and is used only by the REPL. The web UI keeps its own copy in the page, which is lost on reload.
- **Message**: one turn in a conversation, a `Role` (`User`, `Assistant`, `Summary`, `SummaryFailed`, or `Profile`) plus its text. Defined in `src/strata.rs`.
- **Chunk**: one streamed piece of a turn: reasoning text, answer text, or a tool call (`Chunk::Tool`, currently a preformatted `name arguments` string). A subagent run is `SubagentStart`, then its steps as `Nested` chunks, then `SubagentEnd`. Defined in `src/strata.rs`.
- **Config**: the server URL, model name, read timeout, and working directory, held in `strata::Config`. It defaults to the local server, the `qwen3.8-flash-next-iq2_xs` model, a 60-second read timeout, and no working directory. `main.rs` reads the current directory once at startup and passes it to both the REPL and the web server. When set, it is sent to the model as a leading system message on each request, and it is not stored in the session history. If the directory cannot be read, a warning is printed once at startup and the model is not told.
- **StrataError**: the error type for a failed call to Strata. Its variants are `Network` (no connection), `Timeout` (no bytes within the read timeout), `Http` (non-2xx status), `Malformed` (unparseable or unexpected response), `GrammarRejected` (Strata refused the grammar), and `Stopped` (the stream was cancelled).
- **TurnError**: the error type for a turn that did not finish, in `src/turn.rs`. `Stopped` means the user stopped it; `Failed` wraps a `StrataError`; `Step` is a workflow step that could not run, with its reason. The round limit is reported as a `Malformed` error, which the doc does not yet treat as its own kind. Both carry `ran`, the tool calls that ran before the failure, as `name arguments` strings.

## Structure

```
src/
  main.rs     stdin loop, or `web` argument to start the web server
  agent.rs    run_turn: streams a reply, runs requested tools, repeats up to 8 rounds. It hands a run_subagent call to subagent.rs, passing itself as the turn runner
  subagent.rs  run_subagent (the run_subagent tool): runs a profile's instructions and tools in a fresh turn with run_subagent switched off, and returns its final answer. The turn runner is passed in, so this file does not depend on agent.rs
  tools.rs    tool definitions and run(): list_files, read_file, create_file,
              create_directory, delete_file, and delete_directory, plus the note tools
  notes/      mod.rs: note tools, the /notes command and the web notes requests; store.rs: scopes, paths and file operations; index.rs: the start-of-conversation index and summaries; profile.rs: reads profile notes; tests.rs. Notes: Markdown notes in .vise/notes/<category>/<name>.md, local (working directory) or global (home directory)
  workspace.rs  leaf helpers shared by the file and note tools: resolve (path confinement), string_arg,
              line_range, and read_range
  session.rs  Session: message list and the told set, with push, pop, reset, restore, messages, told, set_told, and autosave_name and set_autosave_name (the name the conversation autosaves under; reset and restore clear it) (REPL only)
  file_tree.rs  list_dir: one page of 500 entries of a folder for the web Files panel (POST /api/files, with a dir and an after cursor: the last name shown, so entries added or removed between pages cannot repeat or skip; only one page of candidates is held while a folder is read). Leaves out .git, target and node_modules. Folders load when opened, so no part of the tree is read until it is needed. read_lines: one block of up to 200 lines of a text file, from a byte offset, for the file viewer (POST /api/file)
  saved_sessions.rs  /save, /load, and /sessions (REPL), and save, load, list, and title for the web Sessions panel. A saved
              session is JSON at .vise/sessions/<name>.json: the messages, the told set, and an optional title, not the tool switches. A save keeps the title already in the file
  titles.rs   ensure: the title of a web session, asked of the model once from its first exchange with a text-only request, then written into the session file (POST /api/sessions with action title)
  workflows.rs  load, parse, and command: a workflow is `.vise/workflows/<name>.json`, a list of steps. Each step is instructions, a profile, or a tool with fixed arguments (`{argument}` is replaced by the one argument the user types) or with arguments the model supplies. `/<name> <argument>` runs it. Names that are chat commands are never read. The Workflows panel sends each fixed argument as text, and `type_steps` reads it as the tool's declared parameter type on save, so a string parameter keeps its text exactly. A tool step must give every parameter its tool declares, and a parameter with a listed set of choices (such as scope) takes one of them. The editor shows exactly those fields: a choice box for a set, a number box for a number, and text otherwise
  workflow_runner.rs  run: runs a workflow's steps in one reply. Instructions are a turn of their own, a profile is applied as /profile applies it, and a tool step is forced by grammar (grammar::forced_call) when the model supplies its arguments. When every step ran, the profile that was active before is applied again, if the server remembers one. A failure keeps the profile the last step applied, and lists the calls that ran in the whole workflow
  compaction.rs  after_turn, needs_summary, and summarize: append-only summaries of long conversations
  grammar.rs  the GBNF grammars that block calls to disabled tools: enabled_calls_only (the whole output,
              used when Strata has no lazy grammars) and enabled_calls_after_trigger (a call-only grammar that
              Strata starts at a <tool_call> token)
  strata.rs   Config, Role, Message, Chunk, Reply, StrataError, and the streaming client
  web/mod.rs  std TcpListener HTTP server, one thread per connection:
              serves the UI, proxies /api/chat as server-sent events, runs a workflow when the chat's last line names one, and routes the panels' requests to the modules beside it
  web/files_panel.rs, notes_panel.rs, sessions_panel.rs, tools_panel.rs, workflows_panel.rs  the JSON requests for the Files panel, the Workflows panel (/api/workflows: list, load, save, delete; a save checks the steps and profiles first) (/api/files, /api/file), the Notes section (/api/notes), the Sessions panel (/api/sessions: save, load, list, title), and the Tools panel (/api/tools)
web/
  index.html  page markup and styles. The Tools panel width is set by a divider, clamped to keep a minimum chat width,
              and kept per browser in localStorage (vise-tools-width). A narrower window clamps the shown width only.
  src/app.ts  client entry: reads the event stream and renders reasoning, tool calls, and answer
  src/panels/  one file per side panel (tools, profile, sessions, files, notes, workflows) and the file viewers (viewers.ts). The Workflows panel builds a workflow from fields, one row per step, and saves it through /api/workflows
  src/markdown.ts, http.ts  markdown rendering, and the JSON request and error helpers shared by the panels
  app.js      the page's one script, committed so the server needs no build. scripts/bundle-web.mjs joins the compiled
              files in a fixed order (refused if one is missing from the list). Markdown is rendered in the page by
              marked 12.0.2 and DOMPurify 3.1.6, loaded from cdnjs in index.html. Raw HTML is escaped before
              marked runs, and DOMPurify sanitizes the result. Without the libraries, text is shown escaped.
  tsconfig.json
package.json  TypeScript and concurrently dev dependencies. Scripts: `build` (tsc -p web, then scripts/bundle-web.mjs),
              `watch:ts` (tsc --watch), `watch:rs` (cargo watch, needs cargo-watch installed),
              and `dev` (runs both together)
```

Dependencies run one way: `main`, `web`, and `workflow_runner` call `agent`. `agent` calls `strata`, `tools`, `compaction`, `grammar`, `subagent`, and `turn`. `subagent` calls `notes` (to read a profile), `strata`, `tools`, and `turn`, and receives `agent::run_turn` as a parameter, so it does not call `agent`. `workflow_runner` calls `agent`, `commands`, `grammar`, `notes`, `strata`, `tools`, and `workflows`. `turn` calls `strata` only. `compaction` calls `strata` and `grammar`. `strata` calls `tools` for the definitions. `tools` calls `notes`. Inside `notes`, `mod.rs` calls `store.rs` and `index.rs`, and `index.rs` calls `store.rs`. `notes` and `tools` both call `workspace`, which is a leaf and calls nothing else in the crate. `session` uses `strata` for `Message`. `saved_sessions` calls `session`, `strata`, and `workspace`. There are no cycles.

`strata.rs` is split into layers:

- `message_items(messages, config)` converts messages to wire-format items, with the working directory first when set.
- `open_stream(items, config, constraint)` builds a `ureq` agent with the configured read timeout, sends the request with the tool definitions, and returns a reader over the response body. Failures before any reply text are reported here.
- `relay(reader, url, cancel, on_chunk)` reads server-sent events until `[DONE]`, checks `cancel` before each line, passes each reasoning and content delta to `on_chunk`, assembles streamed tool-call fragments by index, and returns a `Reply` with the answer text and tool calls.
- `stream_reply(items, config, constraint, cancel, on_chunk)` is `open_stream` followed by `relay`. `constraint` is an optional `Constraint { grammar, lazy }`; a lazy one is sent with `grammar_lazy` and a `<tool_call>` token trigger. Whether Strata supports lazy grammars is read once at startup from `/v1/status` (`Config::lazy_grammar`).
- `request_body(items, config, grammar)` builds the JSON body with `stream: true`, the tool definitions, and the grammar when one is given. It is pure.
- `build_body(messages, config)` is `request_body` over `message_items`. It is pure, tested, and used only by tests.
- `parse_reply(url, data)` extracts `choices[0].message.content` from a non-streaming response. It is pure, tested, and used only by tests.

`build_request` (a single-message wrapper around `build_body`) also exists only for tests. `build_request`, `build_body`, and `parse_reply` therefore produce `dead_code` warnings in the binary build.

## Profiles

There is one built-in default profile, in `src/commands.rs` (`DEFAULT_TOOLS` and `DEFAULT_INSTRUCTIONS`). It is applied whenever a conversation starts: the REPL at startup and on `/new`, and the web page when it loads and when New is clicked. `/profile default` applies it again. It cannot be skipped. Applying it sets the tool switches to its tool list, or leaves them alone when the list is `None`. Its instructions join the conversation, or add nothing when the text is empty. The current default leaves every tool as it is and adds no instructions, so it changes nothing until those constants are filled in.

A profile is a note with `profile: true` in its frontmatter and an optional `tools` line, a comma-separated list. `/profile <scope>/<category>/<name>` chooses one. The REPL accepts the command, and the web UI's picker sends the same command through the chat. The `tools` list, when there is one, sets the switches: the listed tools go on and every other tool goes off. A list naming an unknown tool is refused. The note's text, without the frontmatter, joins the conversation as a `profile` message with a header saying the profile is active. Strata receives it as a system message. It stays in the log, so later requests carry it. `/new` clears it with the rest of the conversation, but the switches stay as the profile set them. `src/notes/profile.rs` reads the note, and `commands::profile` applies it. A profile does not end the conversation's first turn (`strata::is_first_turn`), so the notes index still goes on the first user message after a profile is chosen.

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

The note tools keep Markdown notes at `.vise/notes/<category>/<name>.md`. A local note sits under the working directory; a global note sits under the home directory and is shared by every project. Each tool takes `scope` (`local` by default, or `global`). They live in `src/notes/` (`mod.rs` is the surface, `store.rs` and `index.rs` do the work) and receive the two folders as `notes::Roots`, which `tools::run` fills in with the home directory and tests fill in with their own folders:

- `list_notes` takes no arguments and lists every note as `scope category/name`, local first.
- `read_note` takes `scope`, `category`, `name`, `start` and `end`, and reads lines the same way as `read_file`.
- `create_note` takes `category`, `name` and `content`. The content must start with frontmatter between `---` lines that gives `name` and `summary`. It fails if the note exists, and it creates the category directory when needed.
- `edit_note` takes `category`, `name`, `old` and `new`. It replaces `old` only when `old` occurs exactly once in the note.
- `delete_note` takes `category` and `name`.

`category` and `name` may use only letters, digits, `-` and `_`, so a note cannot leave `.vise/notes`. A note's text is not added to the prompt; the model sees it only when it reads the note. The first user message of each conversation carries an index of the notes that have frontmatter, one line per note with its summary (`notes::with_index`). The web server applies it when the request holds a single message, and the REPL when the session is empty. The page keeps the changed message in its history, as it does for tool-status notes, so later requests reuse the same prefix. The index is built when the conversation starts and is not refreshed during it. It lists at most 50 notes, each summary is cut to 200 characters, and the header says the summaries are descriptions, not instructions. Those bounds are the only limit on how much note text reaches every conversation. The index lists local and global notes together, each marked with its scope. The user's `/notes` command uses the same checks.

Every file tool and note tool resolves its path with `tools::resolve(root, path, allow_root)` against the working directory. Checks are applied in this order:

1. Absolute paths (`C:\...`, `\...`), network and device paths (`\\host\share`, `//host/share`), and drive-relative paths (`C:foo`) are refused before any filesystem call. Only relative paths continue.
2. The path is joined to the working directory. Each existing component is inspected with `symlink_metadata`, and only "not found" lets the walk move to the parent. Any other error fails the call.
3. The nearest existing ancestor is canonicalized, the missing components are appended, and the result must start with the canonical working directory. This catches `..` and symlinks that point outside.
4. Unless `allow_root` is set, the working directory itself is refused. Only the read tools allow it, so a write or delete can never target the directory.

These checks run when the tool is called. They are not a sandbox: a link created between the check and the operation is not caught. Without a working directory every file tool returns an error.

Tools can be switched off at runtime, per session. `/tools` lists each tool as on or off, `/disable <tool>` switches one off, and `/enable <tool>` switches it back on. A session is one REPL process, or one browser tab. The REPL's `Switches` belong to its process. Each web tab keeps a random session id in `sessionStorage` and sends it with every chat request, and `web::Sessions` maps each id to its own `Switches`, so a `/disable` in one tab never changes another tab, even when they run at the same time. A tab's switches last for the life of the web server process; a reload of the same tab keeps them. The set is shared only through a mutex on the map and on each session's set, which are locked briefly and never across I/O. Each model round takes one snapshot of the session's switches, which decides both the tools offered in the request and the refusal check, so they agree. Switching a tool does not change the request prompt. The tool list is always the full list from `tools::definitions()`, and the conversation is not edited. Tool definitions sit at the front of the prompt, so changing them would invalidate the server's prompt cache for the whole conversation. While any tool is switched off, each request also carries a GBNF `grammar` built by `src/grammar.rs`, and Strata applies it while decoding, so the model cannot generate a call to a disabled tool. When Strata supports lazy grammars, the grammar is lazy: it is idle until the model starts a call with `<tool_call>`, so prose and reasoning are not constrained. The grammar allows calls in Strata's XML format, with names taken only from the enabled tools. It is sent only while a tool is off, and it does not change the prompt, so the cache still applies. As a backstop, a call to a disabled tool that somehow gets through still returns `error: tool <name> is disabled`. The web UI's Tools panel uses `POST /api/tools` (`web::tools_response`). With a session id and no `name`, it returns every tool from `tools::listing`, with its description and whether it is on. With `name` and `enabled`, it first switches that tool in the tab's own `Switches`, so the panel and `/enable` and `/disable` share one state per tab. The panel reloads its list after each chat reply, so a typed command shows up there too.

The model is also told about switch changes. Each conversation keeps the set of switched-off tools the model has been told about: the REPL keeps it in `Session`, and the web page keeps it and sends it with each request as `told`. `tools::note_changes` compares that set with the current switches and, when they differ, prepends a note such as `[Tool status changed: now switched off: delete_file.]` to the next user message. Only the change is sent, so repeated toggles add one note per change. The new set is recorded only after the reply is delivered: the REPL does it after a successful turn, and the web server returns it in the `done` event, which the page keeps only when it arrives. A failed turn therefore leaves the set unchanged, and the change is announced again. `/new` and the web New button clear the set, so a fresh conversation is told every switched-off tool. If a `done` event never arrives, the page keeps the old set and the note is repeated on the next message. The commands are handled in `src/commands.rs`. The REPL handles them before a turn starts, and the web server answers a command in place of a turn. The page keeps commands out of its conversation. Everything is on at startup, and the state is not saved between runs.

Tool exchanges are not stored in the session. Only the user message and the final answer are kept, so later turns do not see earlier tool results.

On a failed turn the REPL pops the user message it just added, so a failed turn does not stay in the history. The web UI does the same with its own copy.

The `done` event carries the turn's final answer, and the web page stores that text as the assistant message. Text from earlier rounds of the turn is shown on screen but not stored, as in the REPL.

`src/web/mod.rs` limits requests before reading the body: bodies over 1 MiB get 413, and POST `/api/chat` requires `Content-Type: application/json` or it gets 415. Each connection has a 10-second read timeout on the client socket. Each connection is handled on its own thread, so one slow client does not block others. The chat route sends the event-stream headers when the first event is ready. A failure before that is a 502 JSON response.

## UI Principles

- **Avoid nested scrollbars.** A region that scrolls should sit inside a pane that does not also scroll, so a user never has to scroll one box to reach another. Content inside a pane grows to its full height, and the pane is the only thing that scrolls. Long lines wrap instead of scrolling sideways. Where a control cannot avoid its own scroll (a textarea, for example), it should be the only scrolling thing in its pane.
- Side-panel sections are native `details` elements. Only the open ones take height, and a closed one is just its heading.
- **Shared styles are opt-in.** A shared layout rule applies to a class (such as `.row` or `.stack`), never to a bare element type, so a new form or panel gets no layout it did not ask for. The `hidden` attribute always hides its element, whatever display rule the element has. A panel that needs a different layout states it with its own class, not by overriding a shared rule.

## Potential Problems

- **Write tools run without confirmation.** The four write tools change files inside the working directory as soon as the model asks. A model error or injected instruction can create or delete files there. The boundary limits the blast radius but does not prevent it.
- **Tool results are capped, but reading is not.** `tools::run` cuts any result over 16 KiB, so one result cannot fill the context. `read_file` and `read_note` still read the whole file into memory before selecting the range, and `list_files` walks the whole tree to the requested depth, both on the request thread. Depth has no maximum.
- **Tools are limited to the working directory, not to the rest of the machine.** Files under that directory are still readable and changeable by the model, including anything secret stored there. The web server binds to `127.0.0.1` and has no Origin check, which limits exposure but does not remove the risk.
- **Strata read timeout is per read, not per reply.** A reply that keeps producing bytes can run longer than 60 seconds without timing out. Only a stall between bytes trips the timeout.
- **Summaries do not shrink the requests.** `agent::run_turn` passes the whole message log to `strata::message_items`. `compaction::since_last_summary` selects only the messages after the latest summary, and it is used for the size check and the summary request, never for the request itself. So after a summary the model still receives the full history, and the prompt keeps growing. Profile instructions are kept in the log the same way, so they reach every later request. Changing this alters the prompt of long conversations and needs a decision first.
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
- **`parse_messages`** in `src/web/mod.rs`. It returns the 400 messages for a bad request body.
- **`web/src/app.ts`**. It builds its own messages for an unreachable server, a dropped connection, a reply that ends before `done`, and a non-JSON error response (`HTTP <status>`).

Tool errors are returned to the model as `error:` text and are not shown as errors to the user. Errors cross the wire as text only. The client cannot branch on the kind of error, and the JSON and SSE error shapes are handled by separate code paths in `app.ts`.

## Security Concerns

Trust boundaries. Four inputs are untrusted: the user's typed messages (trusted in intent, not in content), the text of files the tools read, the arguments the model writes for tool calls, and the bodies of HTTP requests to `vise web`. The model is not a trust boundary: anything it reads from a file, a listing, or a web page can steer its next tool call, so it can carry injected instructions into the tools.

Controls the architecture should have, and their status:

- **Confinement of file tools.** Every path is resolved against the working directory and must stay inside it after canonicalization. Absolute, network, device, and drive-relative paths are refused before any filesystem call, and the working directory itself cannot be written or deleted. Status: in place (`tools::resolve`). Gap: the check and the operation are separate calls, so a link created between them is not caught, and confinement is only as wide as the working directory.
- **Notes are reachable through the file tools.** Local notes live under `.vise/notes` in the working directory, so `list_files`, `read_file`, `create_file`, and `delete_file` can read, create, or delete them, including names the note tools would refuse. Status: not restricted. Reserving `.vise` from the file tools would close this, but it is a policy change the file tools do not yet make. Notes are also text the model later reads back into its context, so a note can carry injected instructions into a later turn.
- **Global notes are outside the working directory.** The note tools with `scope` set to `global` read, create, edit and delete files under the home directory's `.vise/notes`, which the file tools' confinement does not cover. Only the note tools' own name checks apply, so a global note can be changed by any conversation that uses those tools, in any project. Status: in place by design, and it widens what the model can change. Global notes are also indexed at the start of every conversation.
- **Note summaries reach every conversation.** The notes index (`notes::with_index`) puts each note's summary into the first user message, so the notes in both scopes (the working directory's `.vise/notes` and the home directory's) are untrusted input the model reads without calling `read_note`. A cloned repository can ship notes with planted summaries. Controls: the header marks summaries as descriptions, not instructions; the index caps the count at 50 and each summary at 200 characters. Status: partly in place. Missing: per-note approval and checks on note content.
- **Confirmation for destructive actions.** Deletes and overwrites should need the user's approval, or at least a visible trail the user can review. Status: missing. `create_file` refuses existing paths, and `delete_directory` removes only empty directories, but no tool asks the user first.
- **Separation of data from instructions.** Tool results, file contents, and listings should reach the model marked as data it must not follow as instructions. Status: missing. Results are plain tool messages, and the model has no marker that they are untrusted.
- **Authentication of the web server.** Anyone who can reach `vise web` can change a tab's switches, read its id from its requests, or send messages as that tab. Status: missing. It relies on binding to `127.0.0.1`. Session ids are random but are not secrets from other local software. `POST /api/tools` (the Tools panel) has no other check either: the session id in the body is the only key, so a request that knows an id can switch that tab's tools. Listings do not create a session entry; only a switch does. `POST /api/notes` has the same kind of gap: any request that reaches the server can list, read, create, change and delete local and global notes, and it does not check the caller.
- **Origin and Host checks on the web server.** A page on another origin cannot read responses, because the server sends no CORS headers, and a JSON POST needs a preflight it does not answer. A DNS-rebinding page could still reach the server, since the `Host` header is not checked. Status: partly in place (`text/plain` POSTs are refused with 415); the `Host` check is missing.
- **Session files are trusted as written.** `/load` and the web Load button accept any `.vise/sessions/<name>.json`, including one from a cloned repository. Loading does not check roles, so a file can add a `profile` (sent to the model as a system message) or a `summary`. Status: open. The user decides whether loading should refuse or re-derive these roles.
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
