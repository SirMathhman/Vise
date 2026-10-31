# vise-core Architecture

`vise-core` is the backend library: no stdin, stdout or stderr, no colors, no Ctrl+C handler.
A frontend drives its `Engine` with `Request`s and receives `UiEvent`s through the `Frontend`
trait it passes in.

## Structure

```
src/
  lib.rs             declares the modules. A frontend uses `engine`, `frontend`, `command`, `stop`, and the types they name.
  engine.rs          `Engine`: borrows the provider, the tools, the conversation and the sessions folder, and a frontend
                     drives it. `start` (trust the existing profiles, import and resume sessions, apply the default model, read
                     the command files, run the startup lines), `handle(Request, &mut dyn Frontend) -> Flow`, `shutdown`, and
                     `stop_handle`. It holds the selected profile and runs a chat line as a turn: prepare, run, commit,
                     autosave, the after-turn follow-ups, and a stopped turn. Everything the user should see goes to the frontend.
  engine/commands.rs  the commands that act on tools, notes and saved sessions (`/tools`, `/note`, `/save`, `/load`)
  frontend.rs        `Frontend` (`emit(UiEvent)`, `approve(&str) -> bool`), `UiEvent` (notices, errors, streamed progress, the
                     typed query results `Tools`, `Profiles`, `Models`, `Sessions`, `Notes`, `Note`, `Context`, and `Changed(Change)`;
                     all `serde`), `Change`, `DropCause`, `ToolState`, `NoteLine`, `Sink` (a frontend nobody looks at), and the test-only `TextUi`, which records events and
                     renders the notices as the terminal's text
  command.rs         `Command`, what a frontend can ask for besides a chat line. Typing it is the frontend's business.
  slash.rs           the slash syntax of a text frontend: `HELP` and `command(line)`, which parses `/save work` into a `Command`.
                     The terminal and the window both use it; a frontend that is not text builds `Command`s directly.
  parts.rs           `Parts`: owns the provider, the tool runner, the conversation and the sessions folder an `Engine` borrows,
                     built together (`for_directory`) on the thread that will run the engine; `engine(stop)` borrows them.
  stop.rs            `Stop`: the shared stop switch. `request` asks the running work to stop, `work`/`tracked` mark work a
                     request reaches, `asked`/`clear` read and reset it. `Interrupted` is its error.
  turn.rs            runs one turn: `run_turn` (compaction, and the one retry on ContextFull), `prepare_message`
                     (before-turn, startup, profile, and notes index), `apply_whitelist`, `select_hooks`, and `hook_lines`.
                     It takes the stop switch and the approval and subagent callbacks as parameters.
  subagent.rs        runs one subagent: a fresh conversation under a profile, its turns and follow-ups, the restore of
                     the parent's enabled tools and notes on every exit, and the pass-through of its tool lines to the
                     parent's display (`Parent`).
  session.rs         Message, Turn (checked shape), PartialTurn (a stopped turn as far as it got), SessionError, Timings
                     and RequestRecord (one request's audit row), Conversation (committed history, prompt tokens of the
                     last committed turn, the append-only request log, compaction, drop_oldest_turn, the autosave name,
                     startup text, the before-turn and after-turn lines, and the selected profile's hook lines
                     as `HookLines`), over_budget (80%)
  saved_sessions/    the sessions database, `sessions/sessions.db`, and its error
    mod.rs           declarations, `FOLDER`, `DATABASE`, and `SessionStoreError`. The error lives here, not in `error.rs`,
                     because the database driver's error appears in its variants
    store.rs         the schema, the one place a connection is opened, the transactional write of one session and the
                     append of its request log, the reads behind `names`, `list`, `check_save`, `save`, `exists`,
                     `write`, and `load`, and the `NAME.json` import
    messages.rs      one message as the table holds it: the role, the content, the answered call, and a reply's tool calls
                     as JSON text. A system message contributes no row
    legacy.rs        the frozen `NAME.json` format the import reads
  profile.rs         lists the notes with the category `profile`, loads one by a validated name, and reads its extra header lines
                     (`tools:`, `notes:`, and `hook KIND: COMMAND`) and its content as the instructions
  notes.rs           the notes folder: one file per note. Reads, creates, updates, deletes, and lists notes, and builds the
                     index text. Each takes the folder, which the runner gets from the working directory (`notes_folder`).
                     Listing takes an optional allowed set of names, and returns the readable notes with a message for each
                     note it had to skip, so one bad file does not hide the others; callers print those messages.
  default_model.rs   the default model's name in `model.txt`: loads and saves it as plain text
  startup.rs         runs `startup.txt` before the first prompt, and returns its blocks as one text (or None)
  before_turn.rs     runs `before-turn.txt` before each chat turn, and returns the block the turn's message carries
  after_turn.rs      runs `after-turn.txt` after each committed chat turn, and returns the failing ones as the next message
  shutdown.rs        runs `shutdown.txt`, then the selected profile's shutdown hooks, after the REPL ends
  file_commands.rs   runs the lines of one command file in order through the tool runner, printing each line and its status
  environment.rs     gathers host facts as plain data: the working directory, and the standing instructions from `AGENTS.md`
  error.rs           ProviderError (including Interrupted, which carries the stopped turn as a `PartialTurn`), and
                     MAX_TOOL_ROUNDS; it holds no stop state of its own
  provider/
    mod.rs           declarations only
    types.rs         trait Provider: complete, complete_streaming (default: calls complete and reports nothing),
                         context_size, summarize (returns the summary with the timing of the request that wrote it), model,
                         models, set_model (the last three refuse by default); enum Event
    llama_cpp.rs     the HTTP client; wire structs; the streamed reader; the Stream that holds back answer text until the
                     reply's kind is known; the tool-round loop; the 400 mapping; the `/v1/models` lookup, shared by the
                     context size, `models`, and `set_model`; the model name, in a cell, copied out before each request;
                     conversion between JSON arguments and Values
    grammar.rs       builds the GBNF grammar from the enabled tools: a call rule and an arguments rule per tool, which
                     requires each parameter name from the tool's spec, in order
    prompt.rs        the tool catalogue text, from every ToolSpec; the tool note; the notes index message and the check
                     for whether it is needed
  tools/
    mod.rs           registry: specs(), call(name, values) -> Invocation; declares its children
    types.rs         ToolSpec, Param, ParamType, Value, Arguments, Invocation, ToolCall, ToolError, ToolRunner
    runner.rs        WorkspaceTools: runs an Invocation. It refuses a disabled tool, a note outside the whitelist, and a
                     file-tool write to a command file; asks for approval first when it writes, and says so when the
                     write is to a profile whose hook lines run unprompted;
                     holds the enabled set and the note whitelist; owns the background tasks, ending them when dropped
    run_powershell.rs  runs one Windows PowerShell command in the working directory; after its timeout it becomes a background task
    read_background.rs  returns a background task's output after the offset the model passes
    kill_background.rs  stops a background task and every process it started
    run_subagent.rs    the run_subagent tool: binds profile and task to Invocation::RunSubagent. The runner refuses it; the
                     session's callback runs it.
    notes.rs           the five note tools: each binds its arguments to an Invocation; the run functions call notes.rs
    jobs.rs            the background tasks' bookkeeping: ids, commands, output (capped at 100 KB), and read offsets
    fs/                the file tools, one file each, and path.rs (confine and confine_new)
```

Planned, not yet created: `tools/process/`, the one place that starts, stops, and reaps OS processes (Windows only, with
a Job Object). Today `jobs.rs` holds that code.

## Invariants

### Turns and history

- A successful turn appends its user message, its tool exchanges, and its reply together. A failed turn leaves the
  conversation as it was, except a stopped one, which is committed as it reached (see Interrupts). Neither undoes the files
  the turn changed (see Open Problems).
- The user message is built in this order: notes index, profile text, startup text, before-turn block, then the typed
  line. The index and profile are added only when the history does not carry them. The startup text is added to every
  message until a turn commits, so a failed turn carries it into the retry.
- `Turn::new` checks the shape of every turn: a user message first; then zero or more rounds, each an assistant
  message with tool calls followed by exactly one `Tool` message per call, in order; then a final assistant message
  with no tool calls.
- A turn may make at most `MAX_TOOL_ROUNDS` (10) tool rounds. Exceeding the limit fails the turn.
- Each reply is capped at `max_tokens` 8192, so a reply that never closes its thinking block ends.
- A loaded session is checked turn by turn with the rules `Turn::new` applies, and a file that fails the check is refused
  with the history unchanged.
- The notes index is sent in the user message that carries it, and again whenever the latest index in history differs.

### Interrupts

- Ctrl+C never ends the process while a turn, a request, a tool round, or the startup lines are running. The first press
  asks that work to stop; the work ends at its next check, whether after a reply's chunk, between tool rounds, or when the
  tool returns. Nothing in progress is killed, so a command that is running finishes first.
- A stopped turn is committed with the prepared user message, the tool rounds that finished, and the text the reply had
  reached, followed by a `[the turn was interrupted]` line. It is autosaved like any other turn. Its after-turn lines do
  not run, and no follow-up turn follows it. The line is not resent.
- A press can land before the turn is sent, while the history is being compacted. That stop keeps the user message too, so
  no stopped turn is lost from the history or the database. Whoever stops a turn owns assembling its `PartialTurn`: the
  request layer reports only the reply it reached, and the layer that holds the turn's messages and request records
  (the provider's round loop, or `turn` before the send) adds them. The assembly should be one function with a test that
  needs no server, not repeated at each stop site.
- Every other Ctrl+C quits: at the prompt, after a stop is already asked for, and during the shutdown lines. The exit status
  is 130.
- The request itself checks the flag between chunks, so a long reply stops within a chunk rather than at the end.
- A profile's text is sent with the next user message whenever the history does not carry it, so a failed turn keeps it
  for the retry. Once committed, its text stays in history until compaction or a dropped turn removes it.

### Requests, replies, and the tool loop

- Each request has no `tools` field. It carries a grammar built from the enabled tools. The grammar fixes the reply to a
  thinking block followed by plain text, or one tool call to an enabled tool. Plain text cannot contain `<tool_call>`. A call
  names every parameter of its tool, in the order the tool's spec lists them; the values are any JSON value.
- Only a tool call form runs a tool. A plain-text reply that names a tool runs nothing.
- A disabled tool does not run, even if a reply names it: the grammar stops its generation, and the runner refuses it.
- The model always knows the enabled set from the history it is sent. A user message carries the tool note whenever the
  history does not state the current set.
- Streamed answer text is shown only after the start of the reply rules out a tool call. A reply that is a tool call is
  never shown as text.
- Thinking is shown as a running token count only. Its text is never shown.
- Prompt progress and thinking share one status line, rewritten in place. Answer text or the end of the request ends it.
- A tool call is shown as a line of its own, before it runs: `tool: NAME ARGUMENT`, where the argument is what the call
  acts on (`Invocation::target`), omitted when the arguments name nothing the user would recognize. The line is permanent,
  so the transcript shows which tools ran. The result is not shown. A call that does not run is followed by
  `  did not run: REASON`, so the transcript does not record an action that never happened.
- The call line is drawn before the approval prompt, so a write's prompt follows the line that explains it. The provider
  reports the call, because the tool loop is the only place a call is decoded: `run_call` takes the decoded `Invocation`,
  so the line and the tool that runs come from one decode. A call whose arguments do not bind reports its name alone.
- The line's text is model-controlled: control characters are replaced and it is cut to 100 characters, so a `\r` cannot
  overwrite the `tool:` prefix and a long command cannot flood the terminal.
- A subagent's tool lines reach the parent's display, so a `run_subagent` call is followed by what the subagent ran. Each
  is indented two spaces under the parent's `tool:` line, and its `did not run:` line four, so the transcript shows which
  calls belong to the subagent. Its answer text and status lines do not, because only the parent's reply is shown.
- Overflow handling:
  - A request the server rejects because it exceeds the context (`exceed_context_size_error`) is `ContextFull`. So is a
    tool round whose reply reports a prompt at 80% of the context size; that round's tools are not run.
  - `ContextFull` is retried once, after compaction, from the compacted history.
  - A turn that has attempted a write is never retried. If the context fills after a write, the turn fails with
    `ContextFullAfterChange`.
- Other HTTP errors: a 400 that is not an overflow is `Rejected`, carrying the server's message or the raw body.
  Connection and read failures are `Transport`.
- `run_powershell` requires a `timeout_seconds` between 1 and 30. A command still running when that wait ends becomes a
  background task, and is not stopped. A command with `background` true starts as a background task at once. Each task
  keeps at most its last 100 KB of output.
- A read of a background task takes the offset the model last received and returns the output after it, with the next
  offset. The task holds no read position, so a read repeated by a retried turn returns the same output again. Output is
  decoded at character boundaries, so no character is split across two reads.
- Stopping a background task ends every process the task started, including those whose parent has exited. On Windows
  the task runs in a Job Object with kill-on-close.
- A background task ends with the session, however the process exits.

### Tools and approval

- A write the model asks for runs only after the user approves a description of it. The default is no: only `y` or `yes`
  approves. The user's typed commands (`/note create`, `/note delete`, `/save`, `/model NAME`) do not prompt.
- The approval text for `kill_background` names the task's command and whether it is still running, not only its id.
- Enabling or disabling a tool changes no committed message, and enabling a tool does not approve its writes.
- The note whitelist is checked before approval. A note tool naming a note outside it is refused, so the user is never asked
  to approve a write to a note the model may not use. The index and `list_notes` list only the allowed notes.
- A note name is validated like a profile name, so it cannot leave the notes folder. `create` fails if the note exists;
  `update` and `delete` fail if it does not. A summary or category is one non-empty line.
- Paths: a read resolves its path with `confine` (the path must exist and lie under the working directory). A write
  resolves its path with `confine_new`, which resolves `..` links and requires the parent to exist, so the new file lands
  under the working directory. A path outside the working directory is an error, and nothing is read or written.
- `run_powershell` is not confined. Its command runs in the working directory with the user's full permissions. The
  approval prompt is the only gate, and it shows the command in full.
- Command-file lines and profile hook lines run without a prompt. They are the one exception to the approval rule, besides
  autosave. Their output goes to the model, except shutdown's, which goes to the screen only.

### Context and compaction

- The session owns the compaction budget (`over_budget`, `needs_compaction`). The provider reports `ContextFull`; it does
  not change history.
- Compaction keeps the context message, one summary, and the last two turns, in that order. An empty summary is an error,
  and leaves history unchanged.
- A drop is the fallback when the summary request itself does not fit. It removes the summary if there is one, otherwise the
  oldest turn, and reports how many messages were removed.
- The summary request is recorded in the request log before the history changes, so the cost of the prefill it did is kept
  even though the turns it summarized are gone.
- A context size can be unknown: the server lists the model but reports no size, because the model is not loaded until its
  first request. Unknown is a value of the lookup, not an error. Before a turn it means there is nothing to compact against, so
  the request is sent; after a reply it is read again, since the request has loaded the model. `/compact` does not need the size.
- `/context` prints the context message, then `<prompt tokens> / <context size>`. A failed size lookup is reported on the
  error stream.

### Sessions, notes, profiles

- Every folder the program reads or writes (profiles, notes, sessions) is a path under the working directory, taken once at
  startup and passed down. No module resolves a bare relative folder name against the process folder, and a runner has no
  default folder: each one states its own, so a new runner cannot silently point at the process folder.
- A session is a row in the `sessions` table of `sessions/sessions.db`, with one `messages` row per message in order.
  Its name follows the profile name rule, so it is plain text in a column, never a path. `/save` refuses a name that
  already has a session. Like the other typed commands, it does not prompt. `/load` replaces the history, keeps the current run's context
  message, resets the prompt token count, and starts an empty request log.
- Autosave writes into the sessions folder that `main` passes to `Engine::new`, and `Conversation` holds only whether autosave is on
  and the session name. No conversation or store value carries its own folder, so one run cannot autosave to a second folder.
- A write of a session removes its old messages and inserts the new ones in one transaction, so an interrupted write
  leaves the earlier history. Each message row holds the role, the content, and either the call a tool result answers or
  the reply's tool calls as JSON text.
- Every request a turn makes is recorded in the `requests` table, one row per request, for auditing performance later. A
  turn makes one request per tool round, so each round's prefill has its own row. A row holds the round, whether it was a
  turn or a summary request, the prompt token count, and the timings llama.cpp reported: `cache_n`, `prompt_n`,
  `prompt_ms`, `prompt_per_second`, `predicted_n`, `predicted_ms`, `predicted_per_second`, `draft_n`, and
  `draft_n_accepted`. A number the server did not report is stored as NULL, not 0, so a reader can tell them apart.
- The `requests` log is append-only and is not a child of `messages`. Compaction replaces turns but not the record of the
  requests that made them, and a rewrite inserts only the requests not yet stored, so no request is lost or counted
  twice. A stopped turn keeps the timings of the rounds that finished before the press. A summary request is recorded
  with round 0, because it belongs to no turn's round, so summing by round never counts it with one.
- A write whose request slice is shorter than the log already stored is refused, not silently skipped: that means the
  caller is writing a different session's rows. `/load` starts an empty log, because the requests that produced the
  loaded history belong to the session it came from.
- The log belongs to the session whose history the conversation holds. Taking on another session's history, by `/load` or
  by a `/save`, takes on that session's request rows and none of the run's own, because each request was sent while a
  different history was current. The store is told the name the rows belong to; it does not infer it from a count.
- A request row's prompt count is NULL when the server reported no usage, as its timings are, so a reader can tell "not
  reported" from "zero".
- Autosave is the one write without approval. It writes only rows of `sessions/sessions.db`, after each completed turn,
  and the name is chosen once per run, when its first turn completes.
- A `sessions/NAME.json` file in the format sessions were once saved as is imported as the session `NAME` at launch,
  unless that name is already stored. The files are left in place, so an import can be repeated.
- Nothing but `saved_sessions` opens the database, and `store.rs` is the only file there that does. A name is a column value,
  never a path. The sessions table is upserted rather than replaced, because a replaced row would cascade a delete over the
  messages just written.
- A profile is chosen by name only. The name must be letters, digits, `-` or `_`, so it cannot leave the notes folder.
- Selecting a profile sets every tool's state: the enabled set becomes exactly the profile's tools line, or all tools when it
  has none. It replaces the note whitelist with the profile's notes line, or all notes when it has none. The change is made
  when `/profile NAME` runs, and it replaces any earlier `/tools` choices.
- A profile's header is checked before anything changes. A failed selection (an unknown name, a bad header line, or an unknown
  tool or note) leaves the instructions, tools, notes, and hooks as they were.
- Notes and profiles are plain files; sessions are rows of one database. Only the names in the Definitions say what they may
  contain.

### Command files and profile hooks

- Command files are read at the time their Definitions say: startup once before the first prompt; before-turn and after-turn
  once at launch; shutdown once after the REPL ends. A profile's hook lines are read when the profile is loaded, at selection,
  and held until another profile is selected or the process ends.
- Each run shares one code path (`file_commands`), so a rule added for one applies to the others.
- Command-file lines and hook lines do not depend on the enabled set: they run even when `run_powershell` is disabled, and
  a profile's tools line does not stop its hooks.
- Each command line is printed on screen before it runs, with its status line after it.
- A command still running after 30 seconds becomes a background task, as for `run_powershell`. Shutdown does not wait for it.
- After-turn lines run once per committed chat turn, after the commit and the autosave, never before. A follow-up turn runs under
  every invariant of this section. Follow-up turns form a loop in `engine`, not recursion. At most `FOLLOW_UPS` (5) follow-ups
  follow one typed line. A follow-up that fails (including a `ContextFull` that compaction does not cure) ends the chain and is
  reported.
- Selecting a profile replaces the hook lines held from the one selected before, in the same step that changes its instructions.
  The lines of the previously selected profile never run after another profile is selected. The selected profile's `startup`
  hooks run at once, and their output reaches the model with the next message.
- The file tools refuse any change to a command file, whatever the spelling of its name. They may write a note that is a profile
  (in the notes folder, with the category `profile`) only after the ordinary approval, whose text adds that the profile's h
  eader lines), `create_note` fails because the file exists, and only `delete_note` works. The listing should carry a typed entry
  (name, cause), say once what can be done (fix the header by hand, or delete the note), print each cause once per change, and give
  the model only the name and the kind of cause, never OS error text. A skipped note is never confirmed as a profile
  (`confirm_existing`), which is the right default and must stay.
- A subagent runs a profile's hook lines only when they are the ones the user confirmed: those of the profiles present at
  launch, and those of a profile the user selected with `/profile`. The comparison is on the hook lines in the note as it is when
  the subagent starts, so how or by which tool the note was written does not matter. A profile with no hook lines needs none.

### Subagents

- A subagent runs in a fresh `Conversation` built from its own environment gathering, never the parent's. Its profile is
  applied before its first turn: tools, then note whitelist, then hooks (only those the user has confirmed, see Command files and
  profile hooks), whose startup lines run then. `run_subagent` is
  disabled for it.
- When it ends, on success or failure, the parent's enabled set and note whitelist are restored exactly.
- A subagent's turns obey every turn rule in this section. Its reply is the text of its last turn.
- A `run_subagent` call is a write for the parent turn. The parent records it before the subagent starts, so the parent turn
  is never retried after one. The subagent's writes are approved through the approval function the parent turn supplies.
- The provider starts a subagent only through the callback it was given. It keeps no state across requests, so a subagent's
  turns may run inside a tool round of the parent.

### Model

- The provider names one model in every request: the model it was last set to, which starts as the built-in model.
- `set_model` accepts a name only when the server lists it with a context size. It then sets the model and the context size
  together. A refused switch changes neither.
- `/model NAME` saves the name as the default only after a successful switch. Launch applies the saved default through the same
  `set_model`, before the first prompt. A default the server refuses is reported on the error stream, and the built-in model
  stays in use.
- `model.txt` is read once at launch. Its name is trusted only as far as the server lists it.

### Errors and output

- A `ProviderError` variant's message is true for every path that produces it, and names the setting or step the user can
  change. A variant that would need a different sentence for one producer is split.
- A mapping from an HTTP status and body to a `ProviderError` is a pure function, tested without a server.
- API keys are never printed, logged, or put in error text.
- No function panics on bad input or failed I/O; fallible steps return `Result`.

## Rules

- `provider::llama_cpp` is the only module that knows HTTP, `ureq`, the endpoint, the wire shapes, or the JSON form of tool
  specs and calls. Only `provider::grammar` knows the call syntax as a grammar, and only `provider::prompt` knows the
  catalogue's text and the tool note's text.
- The model name is held by `provider::llama_cpp` alone. `default_model` and the engine pass a name in through `Provider::set_model`,
  and the provider never reads or writes `model.txt`. The name is copied out of its cell before a request starts.
- The provider sends the grammar built from `ToolRunner::enabled()` on every request, and never a `tools` field. The provider
  never compares tool names: refusing a disabled tool is the runner's job (see Open Problems for the one exception).
- `tools` never parses JSON and never imports the provider or the session. The provider decodes a model's arguments into plain
  `Value`s (text, integer, boolean, or `Unsupported`), and passes them with the tool name to `tools::call`, which checks the
  values against the spec and calls its `bind`.
- `notes` takes and returns plain text. Note writes from the model go through `WorkspaceTools` like every other write.
- Adding a tool takes: a file with its `SPEC`, `bind`, and `run`; one `Invocation` variant; one arm in `runner.rs`; one arm in
  `Invocation::writes` (an exhaustive match, no wildcard); one arm in `Invocation::target` for the line the user sees; and
  one entry in the `SPECS` list. The provider and session do not change.
- `run_subagent` is the one tool the runner does not run. Only the session's callback starts a subagent, and only `subagent`
  builds a subagent's conversation.
- `Turn` is built only in the provider's tool loop, and its shape is enforced by `Turn::new`. A stopped turn is a
  `PartialTurn` until the engine records it, which applies the same check before committing.
- `Conversation` is the only holder of committed messages. The engine reads them through `messages()`, `prompt_tokens()`, and
  `context_size` on the provider.
- Tool output goes to the model as text. The backend never writes to a terminal: it emits `UiEvent`s to the `Frontend` it is
  given, and asks it for each approval. The terminal frontend draws them: `render` prints answer text as it streams, prompt
  and thinking progress, one `tool:` line per call, and the end of each request; notices and errors go to stdout and stderr.
  Approval prompts share the same output as `render`.
- `stop::Stop` owns the stop flag and the work counter, and every clone is the same switch. Nothing else installs a handler or calls `exit` for an interrupt;
  the engine, `turn`, the provider's request loop, and the startup lines only run their work inside `Stop::work` (or
  `tracked`, where the work's own result carries what a press must not throw away) and check `asked` where they can stop.
- Limits: 100 lines per function, 500 code lines per file, and 10 files per directory.
- Recursion is allowed only within one module, and only when bounded by a parameter (the directory walk is bounded by depth).
  A chain of turns is a loop, not recursion.
- A parent `mod.rs` declares its children and holds the registry. Types several siblings share live in a leaf module
  (`error.rs`, `tools/types.rs`).

## Dependencies

An arrow means "may depend on". Dependencies only point one way; there are no cycles.

```
vise-core (no `ctrlc`, no terminal or window I/O):
  parts -> engine, environment, provider::llama_cpp, saved_sessions, session, stop, tools::runner
  slash -> command
  engine -> command, frontend, stop, turn, subagent, session, provider::types, tools, profile, saved_sessions,
            default_model, startup, shutdown, before_turn, after_turn, error
  frontend -> provider::types (Event)
  command, stop -> std only
  turn -> session, provider::types, tools, profile, notes, before_turn, after_turn, file_commands, frontend, stop, error
  subagent -> turn, session, profile, environment, provider::types, tools, after_turn, frontend, stop, error (not engine)
  startup, before_turn, after_turn, shutdown -> file_commands, frontend, tools::runner, tools::types
  file_commands -> frontend, tools::runner, tools::types
  profile -> frontend, session (HookLines), notes, environment, tools::runner, tools::specs
  saved_sessions -> session, tools::types, error (and rusqlite for the sessions database; only store.rs opens a connection)
  session -> environment, tools::types (no `error`, `stop`, or provider; its errors live with it)
  provider::llama_cpp -> provider::types, provider::grammar, provider::prompt, session, tools, error, stop
  provider::grammar -> tools (it reads each enabled tool's parameter names from its spec)
  provider::prompt -> session, tools
  provider::types -> session, tools::types, error
  notes -> session (the check whether the index is needed, see Open Problems)
  default_model -> std only, a leaf: it knows neither the provider nor the session
  environment -> std only
  error -> session (PartialTurn, SessionError), stop (Interrupted), std; it holds no logic of its own
  tools -> notes; no provider, session, HTTP, or serde
```

## Open Problems

Each item is a gap between the design above and the code. Items are grouped by area.

### Turns and history

- **Failed turns forget their writes.** A turn that writes and then fails (round limit, transport error,
  `ContextFullAfterChange`) commits none of its messages. The files stay changed, the next turn does not know it, and the
  user sees only the error. The turn must record the writes it applied, and its error must name the changed paths. The same
  holds for background tasks: a task started in a failed turn keeps running, and its id is lost with the turn.
- **Replayed reads lose output.** `read_background` advances the task's read position when it runs. If the turn is then
  retried or fails, the output that read returned never reaches the model. Reads must take the offset from the conversation.
- **Selecting a profile rewrites the enabled set.** A profile's tools line replaces every earlier choice, and a profile without
  one enables every tool, which undoes a `/tools disable`. Whether a profile without a tools line should leave the set alone is
  open: the user chose enable-all.
- **Narrowing the whitelist leaves disallowed notes in history.** Index messages and `read_note` results are committed. After a
  profile narrows the whitelist, the notes it no longer allows stay in the conversation until compaction removes them.
- **A note named `default` is shadowed.** `profile::load` returns the built-in default before it reads the notes, and `names` lists
  `default` once, so a user's `notes/default.md` (instructions, a `tools:` line, hooks) is ignored with no message. A built-in
  with an empty body is also sent as a bare `[Instructions from profile default]` heading on selection and in every subagent
  run; an empty profile should add no text. Callers (`engine`, `subagent`) rely on `load` alone, so the fix belongs in `profile`.
- **Profile text is unbounded.** `profile::load` reads the whole note. A large profile is committed and resent on every later turn.
- **No way to clear a profile.** Once chosen, a profile stays until another is chosen or the process ends, and its hook lines
  stay active.
- **Turn shape is loosened.** `Turn::new` accepts a plain assistant message directly after the user message, and the test
  `summary_may_precede_tool_rounds` requires it. Nothing produces such a message. The allowance and its test must go.
- **Summaries are discarded by their own check.** `summarize` returns `ContextFull` when the summary request's prompt is at 80%,
  even though the request succeeded. The caller then drops the oldest turn.
- **A drop is not a summary.** `Compaction::Dropped` removes history without a summary, so the one-summary rule does not hold after it.
- **Missing usage is zero.** When the server omits `usage`, the prompt count is stored as 0, and `/context` prints `0 / N` as if the
  conversation were empty. The absence must be unknown, not zero. The request log inherits the flaw: its `prompt_tokens` column is
  `NOT NULL` and `Sent` fills it with 0, so a row reads as "the server counted no prompt tokens" when it means "the server said
  nothing". It is the same value the whole run budgets against, so it is fixed once, in `Sent`.
- **Repeated compaction is silent.** If the context is small or the summary large, every turn can trigger a full summary request,
  and nothing reports that compaction freed too little space.
- **A failed request leaves the status line open.** `send` returns on a read or parse error before it reports `Finished`, so the
  status line is not ended before the error notice. The REPL must end an open status line on every outcome.
- **Streamed text outlives a failed turn.** Answer text is printed as it arrives, before the turn is committed. If the turn then
  fails, the partial answer stays on screen while history does not hold it, and a retry prints it again.
- **Rewritten history.** Past tool calls are resent from decoded values. `Unsupported` becomes `null`, and invalid JSON becomes
  `{}`, so the model sees its own calls differently from what it wrote.
- **Oversized output is committed.** A `list_directory` call at depth 5 has no entry or byte cap, and its full output is committed
  and resent on every later turn. A single oversized tool result can break the rest of the session.
- **Unrecoverable long lines.** A line over 100 KB makes every `read_file` range that starts on it fail with "line N is longer than
  100 KB", and the message does not say that no range can read that line.
- **Whole-file reads.** `read_file` reads the entire file and splits every line before applying its cap, so a range near the end of a
  large file costs the full file.

### Notes

- **The notes layer reaches the session.** `notes::needed` takes `&[Message]`, so `notes` imports `session`. The check belongs in
  `provider::prompt`, and `notes` should take plain text.
- **The index reads every note in full.** It reads each note file to produce one summary line, every time it is built. The header
  alone is enough.
- **Note paths skip confinement.** `notes::path` checks the name but not the folder: a symlink named `notes` leads writes outside the
  working directory.
- **Skipped notes are strings, and the model cannot act on them.** `notes::Listing.skipped` holds finished sentences, so each caller can
  only print them. `list_notes` appends them to its result (the model sees `note 'x' is skipped: cannot read note 'x': ...`, with the
  name twice and the raw OS error text), and `prepare_message` repeats them on stderr before every turn until the file is fixed.
  A skipped note is also a dead end for the model: `read_note` and `update_note` fail on it (`update` reads the note first to keep its
  header lines), `create_note` fails because the file exists, and only `delete_note` works. The listing should carry a typed entry
  (name, cause), say once what can be done (fix the header by hand, or delete the note), print each cause once per change, and give
  the model only the name and the kind of cause, never OS error text. A skipped note is never confirmed as a profile
  (`confirm_existing`), which is the right default and must stay.
- **Note content is unbounded.** `create_note` and `update_note` accept any length, and `read_note` returns the whole note.
- **`/note create` writes a placeholder.** The create writes the fixed summary `placeholder` and empty content into the note
  header, and the model sees that summary in the index. Nothing lets the user set a summary or content. The test
  `the_users_own_create_is_not_asked_for_approval` uses a stub runner, so it does not cover the real runner's guards or the
  note it writes.

### Tool protocol

- **Two request formats.** A reply is requested as `<tool_call>` text, but earlier calls are resent as structured `tool_calls` with no
  `tools` field. History should use the reply form, or the wire should use one form only.
- **Prose claims of tools are committed.** The grammar allows a plain reply such as `[Tool: run_powershell]`. Nothing runs, but the
  reply is committed, so later turns treat an action as done.
- **The grammar constrains argument names, not values.** A call must name every parameter, in spec order, so a missing argument
  cannot be generated. Any JSON value passes for a parameter, so a wrong type or a value out of range is found only in
  `tools::call`, after the model has chosen the call.
- **The grammar assumes a thinking block.** The root rule forces the closing `</think>` on every turn reply, but not the opening tag.
- **Misleading error for invalid JSON.** Invalid arguments decode to no arguments, so the model is told "missing 'path'" when its JSON
  was malformed.

### Errors and the provider boundary

- **Non-400 statuses look like connection failures.** A 5xx or other non-2xx reply is `Transport`, whose text says "check that the
  server is running". A `Status { status }` variant is needed for replies the server actually sent.
- **Empty server message.** `{"error":{"message":""}}` produces `Rejected("")`, and the user sees "the server rejected the request: ;".
  An empty or whitespace message must fall back to the raw body.
- **Stringly payloads.** `ToolError::Failed` and `ProviderError::Rejected` hold formatted text, and I/O causes are flattened, so callers
  and tests cannot match on the cause. `Transport` boxes an arbitrary error whose text can echo a response body. `notes` and
  `profile` return `String` errors for the same reason. `saved_sessions` returns `SessionStoreError`, an enum, but its variants
  carry the database driver's error, so its text comes from SQLite.
- **Error homes.** `ToolError` lives in `tools/types.rs`, not `error.rs`. `MAX_TOOL_ROUNDS` lives in `error.rs` but belongs to the provider.
  `SessionError` and `PartialTurn` live in `session.rs`, so `error` depends on `session` and never the other way.
- **No timeouts, one request at a time.** A stalled server blocks the REPL. Connect, send, and read timeouts are not configured.

### Layering and configuration

- **Folders are not all anchored to the working directory.** `ToolRunner::notes_folder` has a default of the relative `notes`,
  which resolves against the process folder for any runner that does not override it. `main` opens the sessions folder as the
  bare `saved_sessions::FOLDER`, while the notes folder comes from the runner's working directory. `profile.rs` and the
  profile-approval check in `tools::runner` take the notes folder. The default of `notes_folder` should be removed so every runner
  must state its folder, and `main` should join the sessions folder to the working directory like the notes folder.
- **The command-file names live in the tool runner.** `startup.rs`, `before_turn.rs`, `after_turn.rs`, and `shutdown.rs` import
  their file names from `tools::runner`, and the runner's guard and approval text use them. The names belong in a leaf module
  that both can use, without the runner.
- **Approval passes through the provider.** `Provider::complete` and `ToolRunner::run` take the approval callback, and the subagent
  callback is carried the same way. Approval belongs to the REPL's prompt, so the runner should be built with an approver.
- **The provider tests tool names.** `provider::llama_cpp::run_call` matches `Invocation::RunSubagent`, checks the enabled set for
  `run_subagent`, and sets the write flag itself, while `Invocation::writes` reports `false` for it. The runner should refuse a disabled
  call and report the write.
- **The budget threshold lives in the provider.** `provider::llama_cpp` imports `over_budget` and decides `ContextFull` from it. The
  session should pass a prompt limit in.
- **`engine` indexes the history.** `Command::Context` reads `messages().first()`. `Conversation::context()` should be the only accessor.
- **Commands are not one table.** `slash.rs` parses the slash commands, but the help text is written by hand beside them.
- **Two sources for one setting.** The endpoint is a constant in `provider::llama_cpp`. The model starts as that module's constant, and
  `default_model` reads a second source, `model.txt`. There is no `config` module.
- **`Conversation` holds run configuration.** The before-turn and after-turn lines, the startup text, the autosave switch, and the
  selected profile's hooks are set on it by `main` or the engine. None of them is history. They should be one `RunConfig` that
  the engine owns beside the history (the profile text it already holds is the start of it).
- **Hook lines are held in the session module.** `HookLines` lives in `session.rs`, and the selected profile's lines are held by
  `Conversation`. They belong with the REPL's selection state, not the history.
- **The source tree exceeds the Modularity limits.** `vise-core/src/` holds 22 entries (the limit is 10), and `tools/` holds 10.
  `saved_sessions/store.rs`, `provider/llama_cpp.rs` and `session.rs` (615, 789 and 640 lines with tests) are at or over the
  500-line limit; `engine.rs` (495) is at it. The core wants sub-folders by concern: `commandfiles/` (startup, before_turn,
  after_turn, shutdown, file_commands), `conversation/` (session, turn, subagent), and `config/` (default_model, environment).
  `cargo clippy --all-targets` reports no errors. Its warnings are the known ones, plus `store::tests::stored_requests`, whose return type is a six-field tuple (`very complex type`), and a method chain
  in `main`'s resume (`then`, `unwrap_or`, `and_then`) that a `match` would state more plainly. The row type belongs in a named struct.
- **One message-like value is threaded through four signatures.** A request's timing travels as `Timings`, then as
  `RequestRecord`, through `send`'s `Sent`, the provider's per-round vector, `Turn`/`PartialTurn`, `Conversation`, `compact`,
  and `Provider::summarize`'s return type, which now carries both a summary and an audit row. Every layer forwards a value only
  the store consumes. The provider should report its requests to one sink the caller supplies, and `summarize` should return the
  summary alone.

### The frontend boundary

The goal is that a second frontend (a GUI, a web page, a test harness) needs nothing from the core except `Engine`, `Request`,
`Frontend`, `UiEvent` and `Stop`. Query results (`Tools`, `Profiles`, `Models`, `Sessions`, `Notes`, `Note`, `Context`) and state changes (`Changed`) are typed,
with the wording and the empty-list hints left to the frontend, and `UiEvent`, `Request`, `Command`, `Flow` and the provider's `Event`
derive `serde`. Today a frontend would still reach around the abstraction in these places:

- **A few notices are still prose.** State changes are typed: `Changed(Change)` carries `ToolToggled`, `ProfileApplied` (the tools it
  changed and the hook lines that are new or changed), `ProfileSelected`, `SessionSaved`, `SessionLoaded`, `ModelSet`, `Compacted`,
  `OldestTurnDropped`, `Reset`, `NoteCreated` and `NoteDeleted`, and one note is `UiEvent::Note`. What is left as text:
  `resumed session NAME` and `imported N session files` (a `Status`), the startup and hook-line output (`startup: CMD`), `the turn
  was stopped before it finished` (a `Notice`, though it is a state change), and every `Error(String)`. `Change` should be closed
  over every transition of engine state: a resumed session is `SessionLoaded` with a `resumed` flag, a launch-time default model is
  `ModelSet`, a stopped turn is `TurnStopped`, and an import is `SessionsImported { count }`. `ModelSet { default_saved: bool }`
  with a separate `Error` that restates the model name is two events for one fact, and the terminal prints nothing for the `false`
  case, so a frontend that ignores `Error` loses the failure. The fact should carry the outcome, `default: DefaultSaved::Saved |
  NotSaved { reason }`, with no second `Error`. A `Change` is emitted only after the state changed (`ProfileApplied` is emitted
  before the hooks are selected, which can still fail). `Error` should carry a kind and a subject so a GUI can attach it to
  the field that caused it, and the `skipped` note lines should not be errors of the command that listed them. The terminal words
  every list's empty case, including `no models`.
- **The wording exists twice.** `vise-cli/src/terminal.rs` and `vise-gui/src/words.rs` each turn the typed query results and
  changes into English. A change to a sentence must be made in both. The shared home could be a text-formatting module in
  `vise-core` that a text frontend opts into, with each frontend's own hint syntax passed in.
- **The window cannot show a resumed session.** The engine sends no event for the messages already in the history, so `--resume`
  starts with an empty transcript while the model has the whole context; the window therefore starts fresh by default. A
  `History` event (or a read-only `Engine::history`) would fix it.
- **Approvals are a bare string.** `approve(&str) -> bool` carries no id, no kind (write, kill, profile file), no path, and no
  origin, so a GUI cannot show a diff or a dialog, and a subagent's request looks like the parent's. It needs an `Approval { id,
  kind, summary, detail, origin }` value, with `origin` naming the subagent and profile. The call blocks the engine thread, which a
  web frontend cannot do: the ideal is `Pending(Approval)` as an event and `Request::Answer { id, accepted }` as the reply.
- **`Engine<'a>` borrows everything.** A GUI cannot keep a borrowing engine in application state. The engine should own its provider
  (`Box<dyn Provider>`), tools and `Conversation`, take a `Paths` value (cwd, sessions folder, notes folder) instead of `&Path`
  arguments to `start` and `shutdown`, and be `Send`, so a frontend can run it on a worker thread.
- **`Command::Help` and `Command::Exit` belong to the frontend.** The engine's enum carries two variants it does not act on
  (`Help` is a no-op arm; `Exit` only returns `Flow::Exit`). `Exit` is an input-loop concern and `Help` is the frontend's text
  (`HELP` lists slash syntax). Both leave `Command`, and `Flow` goes with `Exit`.
- **Startup is a call sequence.** `start` takes `resume: bool` and `cwd`, and the shutdown lines must run on a separate call after the
  loop. `StartOptions { resume: Resume::Last | Fresh | Named }` returned with a `Started` report, and a `Drop`-safe `shutdown`,
  remove the ordering that `main` has to remember. The terminal also calls `Engine::start` before its first prompt with a
  `TerminalFrontend` of its own, so a GUI has no event for "starting" to show.
- **Global files.** `default_model::load` and `save` read and write `model.txt` against the process folder, and `saved_sessions::FOLDER`
  is a bare relative name, so two engines in one process (a server hosting sessions) would collide. Both take the `Paths` value.
- **The worker thread has no failure path of its own.** `Worker` reports a dead thread as `Poll::Gone`, but the panic payload is lost
  to stderr (a window has none), and the shutdown step and the last autosave never run, so a crash costs everything since the
  previous save. The thread body should run under `catch_unwind`, send the payload as an `Error`, and still attempt `shutdown`.
  Closing the window joins the thread on the UI thread, so a tool that ignores `Stop` freezes the exit; the join needs a deadline
  after which the process ends anyway.
- **A blocked approval does not observe `Stop`.** `ChannelFrontend::approve` waits on a plain `recv`. The window's modal hides the
  Stop button, so today only closing the window (which drops the answer channel and counts as No) can end the wait, but any
  frontend that can press Stop while a question is open leaves the engine blocked with the stop flag set. `approve` should wait on
  the answer or the stop, and a stop is a No. Answers are bare `bool`s with no id, so a late answer to an earlier question would be
  taken for the next one; with `Approval { id }` the worker discards answers whose id is not the open question's.
- **`Parts` hard-wires the concrete provider into the core.** `Parts::for_directory` builds `LlamaCpp` and `WorkspaceTools`, so the
  core's composition root depends on its own leaf implementations and a test double needs a hand-built `Parts` literal (the worker
  tests do this). Composition belongs in a thin layer the frontends share, with `Parts` reduced to the data and a builder taking the
  provider and tools as arguments.
- **No test drives the window against the worker.** The worker, the transcript and one frame are tested apart; a streamed answer
  that raises an approval and is answered through the modal is not. A harness that feeds `egui_kittest` input to `ViseApp` over a
  scripted worker would cover the flow that a person cannot script.
- **Interrupts are asked for and observed apart.** `Stop` is the right switch, but `Engine::stop_handle` is unused (marked
  `dead_code`) because the terminal installs its handler first. A frontend must get the handle from the engine, and `start` must
  be stoppable through it.

### Writes and sessions

- **The approval text is unescaped.** `describe` prints paths, content, and edit text as received. Control characters and carriage
  returns can hide or rewrite what the user approves.
- **Approval and confinement are separate steps.** The description shows the path, and `confine_new` resolves it when the write happens,
  so a symlink changed in between goes unseen. `confine_new` checks ancestors with `Path::exists`, which follows symlinks, so a
  dangling symlink is skipped.
- **Writes are not atomic.** `create_file` creates the file before writing it, and `edit_file` rewrites the file in place. A failure in
  between leaves a partial file. Both should write a temporary file and rename it. A session write already does one transaction.
- **Stored sessions are not shown as untrusted.** `/load` commits a session's messages as history with no mark that they came from disk.
- **Autosave sessions accumulate.** Each run that completes a turn leaves a session, and nothing removes them.
- **The request log cannot be read from the app.** The timings are stored, but no command reports them, so auditing means
  opening `sessions/sessions.db` with a SQLite client. A `/timings` command should print the current session's rows with
  per-turn prefill totals.
- **Autosave replaces its own session without checking.** Two runs that start with the same input in the same second overwrite each
  other silently. `/save` refuses a taken name; autosave does not check.
- **Autosave keeps only the latest history.** Each completed turn rewrites the session's messages with the whole history, so compaction
  and a dropped turn remove earlier turns from disk too. The session is a snapshot, not a log.
- **Two runs can resume the same session.** Both append to one name and autosave replaces the whole history, so the later write wins
  silently; only the append-only request-log check can refuse it, and only when the other run has logged fewer requests. A run
  must claim its session (a lock row with the process id, or a compare-and-swap on a stored revision) and fall back to a new
  session when it is claimed.
- **"Latest" is `saved_at`, not use.** `/save NAME` of an old name, or an import, can move which session the next launch resumes.
- **The summary request shares round 1 with the turn's first round.** `summarize` records `round: 1` with `kind: "summary"`, so a
  turn that compacted before its request has two rows at round 1, and a reader summing a turn's prefill counts both. A summary
  is not a round of a turn: it needs numbering of its own, or none.
- **The request log cannot be read without a SQLite client.** Rows are written on every autosave and nothing in the REPL shows
  them, so the audit the log exists for needs an external tool. A `/timings` command should print the current session's rows, or
  a summary of them, through the same store that wrote them.
- **Timings duplicate the rate the server also sends.** `prompt_ms` and `prompt_per_second` are two f64s for one quantity, and so
  are `predicted_ms` and `predicted_per_second`: the rate follows from the count and the time. Storing both lets a row hold a rate
  and a duration that disagree, with nothing to arbitrate.
- **A request's `kind` is a `&'static str`.** The column is free text and the field is a string constant, so a third kind is a new
  literal at its producer that nothing checks; the `CHECK` that pins the message roles does not cover this column. A small enum
  with a stored text form keeps the set closed and the column readable.
- **A session's request log is deleted with the session.** The cascade on `session` removes the audit rows when a session goes,
  although the log records what requests cost rather than what the history holds. Whether an audit log may be deleted is a
  decision to make explicit.
- **The request rows are a child table after all.** The log was declared append-only and not a child of `messages`, yet it hangs off
  `sessions` with a cascade, and its rows are keyed on position within the session like the message rows. A log that outlives its
  subject belongs in a store that no session delete reaches, keyed on the session name and the time, or the cascade is a promise
  the invariants do not keep.
- **An imported session file stays on disk**, so the folder holds the old history beside the database, and a file whose name matches a
  stored session is skipped without a report. Nothing says a file was skipped or unreadable, and `import` returns only a count.
- **No schema version or lock policy.** `open` re-runs `CREATE TABLE IF NOT EXISTS` on every connection and sets no `user_version`, no
  `busy_timeout`, and no WAL mode. The schema should carry a version checked at open, and two runs in one working directory should wait
  for each other rather than fail with `SQLITE_BUSY`.
- **A missing session reads as a driver error.** `load` reports "cannot read session 'x': Query returned no rows", which names no remedy.
  It needs a `Missing { name }` variant that points at `/sessions`.
- **A saved session cannot be replaced.** `/save` refuses a taken name and no command overwrites one, so replacing a session means editing
  the database by hand.
- **The import is not one transaction.** Each imported file is written separately, and the schema-only database file is left behind even when
  every file was refused.
- **A failed autosave is reported once per turn and nothing else.** The turn stays committed, and the next completed turn writes the
  whole history again.

### Commands and background tasks

- **Commands are not logged.** Every approval, write, and command should be recorded before it runs, with its text, working directory,
  approval, and exit status. `run_powershell` records nothing. Deletion and further execution tools wait for this.
- **The command runs only on Windows.** `run_powershell` starts `powershell.exe` with no platform split. The process handling should move
  behind `tools::process`, with the Windows implementation behind it.
- **A second Ctrl+C orphans background tasks.** It exits the process without unwinding, so `WorkspaceTools::drop` does not run and
  the PowerShell processes keep running. The Job Object's kill-on-close flag is the fix; until it is in place the invariant does not
  hold. The first press no longer has this effect, since it stops the turn instead of exiting.
- **A stop is only checked between chunks and rounds.** A press during prompt processing, or during a tool that ignores it, takes
  effect when that step returns. The tool itself is never killed, by design.
- **Tree kill misses orphans.** `taskkill /T` finds processes by their parent link at stop time. A process whose parent has already
  exited is not found.
- **Background tasks are invisible to the user.** Tool output goes only to the model. Nothing lists tasks, and the user cannot see a
  task's output.
- **Kill approval shows only the id.** `describe` prints "stop background task N". The command and state are not shown.
- **Output is decoded per read.** `Output::since` converts each read's bytes lossily. A character split by a read boundary or by the
  100 KB cap becomes replacement characters.

### Profile hooks

- **`/profile` runs hook lines the user may not have read.** The hook gate compares content: a subagent runs a profile's hook lines
  only when they equal the ones confirmed at launch (`profile::confirm_existing`) or by `/profile NAME`. `/profile` itself runs
  the hooks it loads and, when they are new or changed since launch, lists them first, but it does not stop. A model that wrote a
  note with a `hook` line under another category and later made it a profile through `update_note` is therefore caught in a
  subagent and shown at `/profile`, not blocked there. `confirm_existing` also trusts every profile present at launch, including
  one the model wrote in an earlier session.
- **`confirm_existing` confirms without showing.** The hook lines of the profiles present at launch are trusted without being
  displayed. The launch should list each profile's hook lines once, or the confirmed set should be kept in a file the model cannot
  write, so that a profile the model wrote in an earlier session is not trusted silently.
- **Hook lines bypass the profile's tools line.** A profile with `tools: read_file` still runs PowerShell through a hook. This is intended
  for command files, but a profile that narrows the tools is not narrowing what its hooks can do. The user should confirm this decision.
- **Selection can split on an I/O error.** In `Engine::select_profile`, the instructions and tool state change before `select_hooks`
  runs. If that call returns an I/O error, the new profile is selected while the previous profile's hook lines stay active. Hooks and
  instructions should change in one step.
- **Profile errors name no file.** A rejected header line reports only its text, not the profile's name or the line number.
- **Hook output is formatted twice.** `select_hooks` repeats the `Startup command:` block formatting of `startup.rs`.

### Subagents

- **Subagents are mostly invisible.** Their tool lines reach the frontend as `Stream { nested: true }`, but their output and status
  lines go to a `Sink`, and their approvals reach `Frontend::approve` as the same bare string the parent's do.
- **A subagent's shutdown hook does not run.** This is a decision to confirm.

### Command files and hook timing

- **The model can change a command file.** The runner refuses `create_file` and `edit_file` writes to the command files, and an approved
  `run_powershell` that names one says so in its approval text. Any approved command can still write them, and the next launch, exit, or
  chat turn then runs the new lines with no prompt. Full control needs one of two decisions the user has not made: approval at each run,
  or a hash of the approved content kept outside the working directory.
- **Shutdown does not wait for slow lines.** After 30 seconds a shutdown command becomes a background task, and `WorkspaceTools::drop` stops
  it when the process exits. Its output is lost, and the next line runs at once.
- **Startup output is not shown to the user.** Each command prints its `startup:` line and its status line. The output goes to the model only.
  Shutdown output is treated the same way, and goes nowhere.
- **Startup output has no size limit and is never dropped.** A line adds up to its 100 KB output cap, and the block is resent with the first
  turn and every retry. If it does not fit, the turn fails with `ContextFull` after compaction, and the block stays pending, so every later
  line fails the same way until the process ends. Each command's output needs a cap, and a retry that still overflows should drop the block
  with a notice.
- **Before-turn and after-turn lines run on every turn.** Each turn waits for their sum (up to 30 seconds per line) before its request
  starts, and a slow line becomes a background task that the next turn starts again. Tasks have no count limit.
- **A retry runs the before-turn lines again.** A turn that fails commits nothing, and the typed line sent again runs every before-turn line
  again. Side effects repeat, and the first run's output is lost. Before-turn needs the same hold as startup, or a stated rule that each
  attempt is a new run.
- **Output is unbounded and committed.** Each line's output (up to 100 KB) enters history and is resent with every later request. If the
  block does not fit the context, compaction cannot recover, because each attempt runs the command again and produces the same block.
- **A follow-up that fails by overflow ends the chain without saying why.** The error does not say that an after-turn line is still
  failing. A test pins the stop (`follow_up_that_overflows_ends_the_chain`).
- **After-turn output is not shown.** Only the status line is printed. The output that explains a failure goes to the model only.
- **Startup, before-turn, and after-turn repeat one wrapper.** The three modules and `shutdown.rs` differ only in the file name, the label,
  and the block prefix. `main` repeats the load-and-store match for three of them. Loading and block formatting belong in `file_commands`.

### Model

- **Unknown context size is an error variant that callers must remember to handle.** `Provider::context_size` returns
  `ContextSizeUnknown` as an `Err`, and only `turn::compact_if_full` turns it into "skip". The budget checks inside
  `complete_streaming` and `summarize_messages` still propagate it with `?`, so a server that unloads an idle model between the
  request and the check fails a turn that already succeeded, and `/context` reports a lookup failure for a normal state. The lookup
  should return `Result<Option<u64>, _>`, and each caller states its own policy for `None` (compaction skips, the in-turn check
  assumes room, `/context` prints the count alone).
- **`/model NAME` is checked, not confirmed.** The switch is checked against the server's list and context size, and the save
  follows it. Typed commands do not prompt by design, so this is not an approval gap.
- **`model.txt` is not protected from model writes.** The file tools guard the command files, not `model.txt`. An
  approved `edit_file` changes the default for the next launch, and the approval text does not say so.
- **The default file is written in place.** `default_model::save` truncates the file before writing. A crash leaves an empty file, which
  `load` reads as no default, so the launch silently uses the built-in model. The save must write a temporary file and rename it.
- **The model cell is borrowed for the whole request.** `complete` and `summarize_messages` pass `&self.model.borrow()` into `send`, so the
  borrow lasts through each `on_event` callback. Nothing re-enters today, but a callback that calls `set_model` would panic.
