# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server with an OpenAI-compatible
`/v1/chat/completions` endpoint. The model can read and write files under the working directory
through tools; the user approves every write.

This document describes the design and lists, once, where the code does not yet meet it (Open
Problems). It is a reference, not a changelog: finished work is removed, not annotated.

## Definitions

- **Turn**: one user line, the tool exchanges the model makes while answering it, and the final
  assistant reply. A turn is committed to the conversation whole or not at all. A turn sent because an
  after-turn line failed (see After-turn) is a turn of its own, whose user message is that failure.
- **Message**: an enum with one variant per role: `System`, `User`, `Assistant` (content and the tool
  calls it requested), and `Tool` (content and the id of the call it answers). A `Tool` message always
  has a call id.
- **Conversation**: the committed history sent to the model on every turn. Only `session` changes it.
- **Context message**: the leading `system` message describing the host environment: the working directory,
  then the standing instructions when the working directory holds an `AGENTS.md`. It is gathered at startup,
  sent on every turn, and kept by compaction, which never removes it.
- **Standing instructions**: the text of `AGENTS.md` in the working directory, read once at session start.
  Its text is part of the context message and reaches the model verbatim. A change to the file takes
  effect only in a new session.
- **Provider**: a backend that turns a conversation into one turn, reports the context size, and writes
  summaries. llama.cpp is the only provider.
- **Prompt tokens**: the prompt token count the server reports for the last request of a turn. It is
  the figure that grows toward the context size.
- **Context size**: the token capacity of the configured model, read from the server once per session.
- **Compaction**: replacing older history with a summary the model wrote. The result keeps the context
  message, one summary (an assistant message with no tool calls), and the last two turns. Compaction
  runs on `/compact`, and before a turn when the last prompt tokens reach 80% of the context size.
- **Tool catalogue**: the text listing every tool with its arguments. It is joined to the leading system
  message of each request only, never stored in the conversation, and it lists disabled tools too, so it
  never changes during a session.
- **Enabled tools**: the tools the model may call. The runner holds the set, `/tools` and the selected
  profile's tools line change it, and each request's grammar is built from it. A disabled tool is neither
  offered nor run.
- **Tool note**: the line `[Tools enabled: ... Tools disabled: ...]` naming every tool and its state. It is
  how the model is told the enabled set.
- **Tool call form**: a reply consisting of `<tool_call>`, a JSON body with `name` and `arguments`, and
  `</tool_call>`. It is the only reply form that runs a tool. Any other reply is text.
- **Write**: a call that changes the filesystem or runs or stops a program: a tool call (`create_file`,
  `create_directory`, `edit_file`, `run_powershell`, `kill_background`, `create_note`, `update_note`,
  `delete_note`, `run_subagent`), or a user's slash command that does the same (`/note create`, `/note delete`, `/save`). A write
  runs only after the user approves it, whoever asked, except autosave (see Session) and the command lines
  (see Command file). A declined write is reported to the model as an error, or to
  the user, and changes nothing.
- **Note**: a named file, `notes/NAME.md` under the working directory. The name is letters, digits, `-`
  and `_`. The file starts with a `---` header holding one `summary:` line and one `category:` line, then
  the content. Notes persist across sessions.
- **Session**: the history after the system context, saved as `sessions/NAME.json` by `/save` and replaced
  by `/load`. A session is a persistence path like a note: loading one puts its text back before the model.
  Autosave is always on: after each completed turn the history is written to a session named from the run's
  first input and the time in seconds, so each run has its own file. It is the one write that needs no approval.
- **Startup**: the lines of `startup.txt` under the working directory, each a Windows PowerShell command. They
  run once, in order, before the first prompt, through the tool runner, with approval answered yes and no prompt.
  Each command's block (its text, then its output and exit status, or its error) is held until a turn commits,
  and is then sent with that turn's user message. A command still running after 30 seconds becomes a background
  task, as for `run_powershell`. The file is read at launch only.
- **Shutdown**: the lines of `shutdown.txt` under the working directory, each a Windows PowerShell command. They
  run once, in order, after the REPL ends: at `/exit`, at end of input, or after a stdin read failure. Ctrl+C
  ends the process without them. They run after the last autosave, through the same tool runner, with approval
  answered yes. Their output and status go to the screen only, never to the model or the history, so nothing
  they do is saved in a session. A command still running after 30 seconds becomes a background task, which is
  stopped when the process exits, so shutdown does not wait for it.
- **Before-turn**: the lines of `before-turn.txt` under the working directory, each a Windows PowerShell command. They run
  before every chat turn (not slash commands), in order, through the tool runner, with approval answered yes. Their block
  (the command, then its output and status, or its error) is prepended to that turn's user message after the startup text,
  and is committed with the turn. Their output goes to the model only. A command still running after 30 seconds becomes a
  background task, as for startup. The file is read once at launch.
- **After-turn**: the lines of `after-turn.txt` under the working directory, each a Windows PowerShell command. They run
  after each chat turn commits (not slash commands), in order, through the tool runner, with approval answered yes. Each
  line's status is shown on screen and its output goes to the model, as for before-turn. A line fails when its result's
  first line is `exit code: N` with N not zero. A line still running in the background, or one that could not run, is not a
  failure. The failing lines' commands and results form the next user message, which starts a follow-up turn. Up to
  `after_turn::FOLLOW_UPS` (5) follow-up turns may follow one typed line. When the limit is reached, the last turn stays
  committed and the failure is reported on the error stream. The file is read once at launch.
- **Command file**: `startup.txt`, `shutdown.txt`, `before-turn.txt`, `after-turn.txt`, or a profile file (`profiles/NAME.txt`),
  whose hook lines are command lines. The file tools refuse to change any of them. Only `run_powershell` can, and its
  approval text says so when a command names one. Profile files are a gap today (see Open Problems).
- **Notes index**: the list of every note's name, category, and summary, or `[Notes]` followed by `(none)`.
  It reaches the model as a prefix of a user message whenever the latest index in history is not the
  current one.
- **Background task**: a PowerShell command that keeps running after its turn's tool call returns. It
  gets an id, its output is collected while it runs, and the model reads that output with
  `read_background` and stops it with `kill_background`. Background tasks are stopped when the session ends.
- **Profile**: a named set of instructions, kept as `profiles/NAME.txt` under the working directory. The
  user selects one with `/profile NAME`. Its text, under a heading that names it, is prepended to the next
  user message only. The system prompt never changes. A profile may open with header lines, in any order:
  a `tools:` line naming the tools it allows, a `notes:` line naming the notes the model may use, and any
  number of `hook KIND: COMMAND` lines. Selecting it enables exactly the named tools (an empty list enables none),
  and a profile without the tools line enables every tool. A profile without the notes line allows every note.
  Every tool name must be a known tool, every note name a valid note name, and every hook kind one of `startup`,
  `shutdown`, `before-turn`, or `after-turn`, or the profile is rejected when loaded.
- **Profile hook**: a `hook KIND: COMMAND` line of the selected profile. It is a command line of the same kind
  as the lines of the matching command file, and is held only while its profile is selected. A `startup` hook
  runs when the profile is selected, or when a subagent starts under it. A `before-turn` or `after-turn` hook runs on each chat turn after the global
  lines of its kind. A `shutdown` hook runs at exit after the global shutdown lines, if the profile is still
  selected then. Several hooks of one kind run in the order written.
- **Subagent**: a turn run under a named profile in a fresh conversation, started by the model with
  `run_subagent` (`profile`, `task`). It takes the profile's instructions, tools, notes and hooks, cannot start
  another subagent, and returns only its final reply to the parent. It is never autosaved.
- **Note whitelist**: the set of note names the model may use, held by the runner and set by the selected
  profile's `notes:` line, or all notes when there is none. It limits the notes index, `list_notes`, and the
  four note tools. It does not limit the user's own `/notes` and `/note` commands.
- **Event**: a progress report from the provider during one request: prompt-processing progress (tokens
  processed of the prompt's total), a running thinking-token count, a piece of answer text, or `Finished`.
  Events are for display only. They never change the turn or the conversation.
- **Wire type**: a struct matching the JSON shape of a provider request or response. Wire types never
  leave `provider::llama_cpp`.

## Invariants

- A successful turn appends its user message (with any notes index, profile text, and startup text), its tool
  exchanges, and its reply together. A failed turn leaves the conversation as it was. It does not undo files the
  turn changed (see Open Problems).
- The user message is built in this order: notes index, profile text, startup text, before-turn block, then the typed line. The
  index and profile are added only when the history does not carry them. The startup text is added to every
  message until a turn commits, so a failed turn carries it into the retry. It is never added again after commit.
  The before-turn block is run from the lines held since launch, on each chat turn, including a retry (see Open Problems).
- Startup, shutdown, before-turn, and after-turn commands, and profile hooks, are the exception to the approval invariant.
  They run without a prompt, because the user wrote the file or selected the profile. Each command's line is printed before it runs. Startup output and status go to the
  model; shutdown output goes nowhere. Before-turn and after-turn output go to the model too. The model can change a command file through approved writes (see
  Security and Open Problems).
- Command files are read from the working directory at each run only: startup once before the first prompt,
  before-turn and after-turn lines once at launch, and shutdown once after the REPL ends. A profile's hook lines are read
  when the profile is loaded, at selection, and are held until another profile is selected or the process ends. Each run
  shares one code path (`file_commands`), so a rule added for one applies to the other.
- Hook lines do not depend on the enabled set. A profile's tools line does not stop its hooks, and they run even when
  `run_powershell` is disabled, as the command files do.
- Selecting a profile replaces the hook lines held from the one selected before, in the same step that changes its
  instructions. A failed selection (an unknown name, a bad header line, or an unknown tool or note) leaves both as they
  were. The lines of the previously selected profile never run after another profile is selected.
- `Turn::new` checks the shape of every turn: a user message first; then zero or more rounds, each an
  assistant message with tool calls followed by exactly one `Tool` message per call, in order; then a
  final assistant message with no tool calls.
- A turn may make at most `MAX_TOOL_ROUNDS` (10) tool rounds. Exceeding the limit fails the turn.
- After-turn lines run once per committed chat turn, after the commit and the autosave, never before it. A follow-up
  turn runs under every invariant of this section. Follow-up turns form a loop in `repl`, not recursion. At most
  `FOLLOW_UPS` follow-ups follow one typed line. A follow-up that fails (including a `ContextFull` that compaction
  does not cure) ends the chain and is reported; its failure text is not kept.
- A subagent runs in a fresh `Conversation` built from its own environment gather, never the parent's. Its profile
  is applied before its first turn (tools, then note whitelist, then hooks, whose startup lines run then), and
  `run_subagent` is disabled for it. When it ends, on success or failure, the parent's enabled set and note
  whitelist are restored exactly.
- A `run_subagent` call is a write for the parent turn. The parent records it before the subagent starts, so the
  parent turn is never retried after one. The subagent's writes are approved through the approval function the
  parent turn supplies.
- The provider starts a subagent only through the callback it was given. It keeps no state across requests and
  builds each request from the conversation passed to it, so a subagent's turns may run inside a tool round of the
  parent.
- A subagent's turns obey every turn rule in this section (message order, turn shape, round limit, after-turn
  follow-ups bounded by `FOLLOW_UPS`, compaction). Its reply is the text of its last turn.
- Streamed answer text is shown only after the start of the reply rules out a tool call. A reply that is a
  tool call is never shown as text, whatever its later content.
- Thinking is shown as a running token count only. Its text is never shown.
- Prompt progress and thinking share one status line, rewritten in place. Answer text or the end of the
  request ends the line. A request that fails before either leaves the line open (see Open Problems).
- Overflow handling:
  - A request the server rejects because it exceeds the context (error type
    `exceed_context_size_error`) is `ContextFull`. So is a tool round whose reply reports a prompt at
    80% of the context size; that round's tools are not run.
  - `ContextFull` is retried once, after compaction, from the compacted history.
  - A turn that has attempted a write is never retried. If the context fills after a write, the turn
    fails with `ContextFullAfterChange`.
- Other HTTP errors: a 400 that is not an overflow is `Rejected`, carrying the server's message or the
  raw body. Connection and read failures are `Transport`.
- Compaction keeps the context message, one summary, and the last two turns, in that order. An empty
  summary is an error and leaves history unchanged.
- A drop is the fallback when the summary request itself does not fit. It removes the summary if there
  is one, otherwise the oldest turn, and reports how many messages were removed.
- Paths: a read resolves its path with `confine` (the path must exist and lie under the working
  directory). A file write resolves its path with `confine_new`, which resolves `..` lexically and
  requires the deepest existing ancestor to lie under the working directory. A path outside the working
  directory is an error, and nothing is read or written.
- `run_powershell` is not confined. Its command runs in the working directory with the user's full
  permissions, and can read, write, or delete anything the user can. The approval prompt is the only
  gate, and it shows the command in full.
- `run_powershell` requires a `timeout_seconds` between 1 and 30. A command still running when that wait
  ends becomes a background task, and the command is not stopped. A command with `background` true starts
  as a background task at once. Each task keeps at most its last 100 KB of output.
- A read of a background task takes the offset the model last received and returns the output after it,
  with the next offset. The task holds no read position, so a read repeated by a retried or discarded turn
  returns the same output again. Output is decoded at character boundaries, so no character is split
  across two reads.
- Stopping a background task (`kill_background`) ends every process the task started, including those
  whose parent has already exited. On Windows the task's processes run in a Job Object with
  kill-on-close, so ending the job, or closing its last handle, ends them all.
- A background task ends with the session, however the process exits: normal return, error, or
  interrupt.
- The approval text for `kill_background` names the task's command and whether it is still running, not
  only its id. The user approves what will stop, not a number.
- A write runs only after the user approves a description of it. The default is no: only `y` or `yes`
  approves. This holds for the user's own note commands as for model calls.
- A note name is validated like a profile name, so it cannot leave the notes folder. `create` fails if the
  note exists; `update` and `delete` fail if it does not. A summary or category is one non-empty line.
- The notes index is sent in the user message that carries it, and only when the latest index in history
  differs. Compaction or a dropped turn that removes it causes it to be sent again.
- Slash commands (`/compact`, `/context`, `/exit`, `/help`, `/tools`, `/profile`, `/save`, `/load`,
  `/sessions`) are never sent to the model. Every other line is, including `exit`, `quit`, and unknown slash commands.
- A session is the history after the system context, saved as `sessions/NAME.json`. The name rule is the
  profile's, so it cannot leave the folder. `/save` refuses a name that already has a session, and asks for
  approval before it writes, as a model write does. `/load` replaces the history and keeps the current run's
  system context, and it resets the prompt token count. A loaded history is checked turn by turn with the rules
  `Turn::new` applies, and a file that fails the check is refused with the history unchanged. `/sessions` lists
  only names `/load` accepts.
- A profile is chosen by name only. The name must be letters, digits, `-` or `_`, so it cannot leave the
  profiles folder. The selected profile is sent with the next user message whenever the history does not
  carry it (`profile::carried`), so a failed turn keeps it for the retry. Once committed, its text stays in history until
  compaction or a dropped turn removes it.
- Selecting a profile sets every tool's state: the enabled set becomes exactly the profile's tools line, or
  all tools when it has none. It also replaces the note whitelist with the profile's notes line, or with all
  notes when it has none. The change is made when `/profile NAME` runs, not with the next message, and it
  replaces any earlier `/tools` choices. The tool note then reaches the model with the next user message.
  The same command replaces the held hook lines, and runs the new profile's `startup` hooks at once; their
  output reaches the model with the next user message, after any startup text already held.
- The note whitelist is checked before approval. A note tool naming a note outside it is refused, so the
  user is never asked to approve a write to a note the model may not use. The index and `list_notes` list
  only the allowed notes, and a disallowed note is not read to build them.
- Each request has no `tools` field. It carries a grammar built from the enabled tools, which fixes the
  reply to a thinking block followed by plain text or one tool call to an enabled tool. Plain text cannot
  contain the `<tool_call>` marker.
- Only a tool call form runs a tool. A plain-text reply that names a tool runs nothing.
- A disabled tool does not run, even if a reply names it. The grammar stops its generation, and the runner
  refuses it again before it runs.
- Enabling or disabling a tool changes no committed message, and enabling a tool does not approve its writes.
  Each write still needs approval.
- The model always knows the enabled set from the history it is sent. A user message carries the tool note
  whenever the history does not already state the current set. The note is committed with that message, and
  compaction or dropping a turn ends the statement it carried, so the next user message repeats it.
- Each reply is capped at `max_tokens` 8192, so a reply that never closes its thinking block ends.
- API keys are never printed, logged, or put in error text.
- No function panics on bad input or failed I/O; fallible steps return `Result`.

## Structure

```
src/
  main.rs            wiring: reads .env and LLAMA_API_KEY, takes the working directory, builds the
                     provider and tool runner, runs the REPL. Fatal startup errors go to exit_with.
  repl.rs            the input loop over generic BufRead/Write. Hands each turn's provider Events to render.
                     Parses and runs slash commands
                     (including `/tools`, `/tools enable NAME`, `/tools disable NAME`, `/profile`,
                     `/profile NAME`, which also sets the enabled tools from the profile and makes its hook lines the active ones, `/notes`, `/note show`,
                     `/note create`, `/note delete`, `/save`, `/load`, `/sessions`), holds the selected
                     profile until a turn succeeds,
                     hands each turn to `turn` with its approval and subagent callbacks, runs the follow-up turns, asks
                     for approval of writes, and writes replies and notices
  session.rs         Message, Turn (checked shape), Conversation (committed history, prompt tokens of
                     the last committed turn, compaction, drop_oldest_turn, the autosave folder, the session name
                     chosen for the run), over_budget (80%). It holds no command lines, global or profile (see Open Problems)
  environment.rs     gathers host facts as plain data (working directory, standing instructions from
                     AGENTS.md in it)
  render.rs          displays provider Events: one status line (prompt progress, then the thinking count,
                     rewritten in place), answer text, and the end of each request. Owns the output that
                     the answer and the approval prompt share.
  error.rs           ProviderError, SessionError, MAX_TOOL_ROUNDS
  commands.rs        parses a slash command into `Command`, and holds the help text (no I/O)
  startup.rs         runs startup.txt once before the first prompt, and returns its blocks as one text (or None)
  shutdown.rs        runs shutdown.txt, then the selected profile's shutdown hooks, once after the REPL ends
                     (`run_with_profile`); its output is only shown
  before_turn.rs     runs before-turn.txt's lines before each chat turn, through file_commands, and returns
                     the block the turn's message carries (or None)
  after_turn.rs      runs after-turn.txt's lines after each committed chat turn, and returns the failing ones as the
                     text of the next user message (or None)
  file_commands.rs   runs the lines of one command file in order through the tool runner, with approval answered
                     yes, printing each line and its status; returns each command with its result text
  turn.rs            runs one turn:
                     `run_turn` (with compaction and the one retry on ContextFull), `prepare_message` (before-turn,
                     startup, profile and notes index), the whitelists a profile sets, `select_hooks`, and the
                     joining of global and profile hook lines. It takes the approval and subagent callbacks as
                     parameters. It depends on neither repl nor subagent.
  subagent.rs        runs one subagent: a fresh conversation under a profile, its turns and follow-ups, and the
                     restore of the parent's enabled tools and notes on every exit. It depends on turn, not repl.
  command_file.rs    (not yet created; the names are in tools::runner, see Open Problems) leaf, std only: the
                     names of startup.txt, shutdown.txt, before-turn.txt, and after-turn.txt, whether a path names one
                     (case-insensitively, and after Windows drops trailing dots and spaces), and `HookLines`, the command
                     lines a profile binds by kind
  profile.rs         lists the profiles folder's .txt files, loads one by a validated name, and splits its
                     header lines (`tools:`, checked against the tool catalogue, `notes:`, checked
                     against the note name rule, and `hook KIND: COMMAND`, checked for its kind, in any order) from its
                     instructions
  saved_sessions.rs  the sessions folder: saves a history as JSON, lists and loads sessions by a validated
                     name. Tool call arguments are stored as JSON values; the system context is not stored.
  notes.rs           the notes folder: one file per note. Reads, creates, updates, deletes, and lists notes,
                     and builds the index text. Listing and the index take an optional allowed set of names;
                     the user's commands pass none. Plain text only; it depends on std alone.
  provider/
    mod.rs           declarations only
    types.rs         trait Provider: complete, complete_streaming (default: calls complete and reports
                     nothing), context_size, summarize; enum Event
    llama_cpp.rs     the HTTP client; wire structs; the streamed (SSE) reader; the Stream that holds back
                     answer text until reply_kind rules out a tool call; the tool-round loop; the 400 mapping
                     (bad_request); the /v1/models lookup; conversion between JSON arguments and Values;
                     the catalogue joined to the first system message of each request; the tool note
                     prepended when the history does not state the enabled set (checked, not stored)
    grammar.rs       builds the GBNF grammar from the enabled tool names: thinking block, then text that
                     cannot contain the `<tool_call>` marker, or one call. Sent with each request.
    prompt.rs        the tool catalogue text, from every ToolSpec, enabled or not; the tool note; the notes
                     index message and the check for whether it is needed
  tools/
    mod.rs           registry: specs(), call(name, values) -> Invocation; declares its children
    types.rs         ToolSpec, Param, ParamType, Value, Arguments, Invocation, ToolCall, ToolError,
                     ToolRunner (run, enabled, set_enabled, allowed_notes, set_allowed_notes);
                     Invocation::note_name names the note a note tool touches
    runner.rs        WorkspaceTools: runs an Invocation, refuses a disabled one, a note outside the
                     whitelist, and a file tool write to a command file, asks for approval first when it
                     writes, holds the enabled set and the note whitelist, and owns the background tasks,
                     ending them when it is dropped
    run_powershell.rs  runs one Windows PowerShell command in the working directory; after its
                     timeout it becomes a background task
    read_background.rs  returns a background task's output after the offset the model passes
    kill_background.rs  stops a background task and every process it started
    run_subagent.rs    the run_subagent tool: binds profile and task to Invocation::RunSubagent. The runner refuses
                     it; the session's callback runs it.
    notes.rs         the five note tools (list, read, create, update, delete): each binds its arguments to an
                     Invocation; the run_* functions call notes.rs and map its errors to ToolError::Failed
    jobs.rs          the background tasks' bookkeeping: ids, commands, output (capped at 100 KB), and
                     read offsets. It holds no OS process handling.
    process/         (not yet created; jobs.rs holds this today) the one place that starts, stops, and reaps
                     OS processes; Windows only
                     (Job Object, kill-on-close). Another platform adds a sibling module here.
    fs/              the file tools, each one file, with path.rs
      mod.rs         declares its children
      path.rs        confine (existing paths) and confine_new (paths a write creates)
      list_directory.rs  recursive listing to a depth of 1 to 5
      read_file.rs   a 1-based line range, capped at 500 lines or 100 KB
      create_file.rs a new file; fails if the path exists
      create_directory.rs  creates missing parents; succeeds if the directory exists
      edit_file.rs   one exact, unique replacement in an existing file
```

Dependencies (an arrow means "may depend on"; there are no cycles):

```
main -> repl, session, provider::llama_cpp, tools::runner, startup, shutdown, before_turn, after_turn, saved_sessions, environment, error
startup, shutdown, before_turn, after_turn -> file_commands, command_file, std
file_commands -> tools (registry and types), command_file, std
command_file -> std only (the names of the four command files, whether a path names one, and HookLines)
tools::runner -> command_file
repl -> turn, subagent, provider::types, session, tools (registry and types), profile, notes, saved_sessions, render, file_commands, command_file, error
turn -> provider::types, session, tools (registry and types), command_file (HookLines), file_commands, before_turn, after_turn, error, std
subagent -> turn, profile, environment, session, provider::types, tools (registry and types), after_turn, error, std (not repl)
render -> provider::types
profile -> command_file (HookLines), session (Message), notes (valid_name), tools (registry: specs), std
provider -> session (Message, Turn, over_budget), tools (registry and types), notes, error
session -> environment, tools::types (ToolCall only)
notes -> std only (it neither sees messages nor the provider)
saved_sessions -> session (Message), tools::types (ToolCall, Value), serde, std
tools -> tools' own types, notes, std (no provider, session, HTTP, or serde)
tools::process -> std and the platform binding (Windows Job Object); nothing outside tools::process
                  names a platform API
```

## Rules

- `provider::llama_cpp` is the only module that knows HTTP, `ureq`, the endpoint, the wire shapes, or
  the JSON form of tool specs and calls. Only `provider::grammar` knows the call syntax as a grammar, and
  only `provider::prompt` knows the catalogue's text and the tool note's text.
- The provider sends the grammar built from `ToolRunner::enabled()` on every request, and never a `tools`
  field. The provider never compares tool names: refusing a disabled tool is the runner's job.
- `tools` never parses JSON and never imports the provider or the session. The provider decodes a
  model's arguments into plain `Value`s (text, integer, or `Unsupported`) and passes them with the tool
  name to `tools::call`. `call` finds the spec, checks the values against its parameter types, and calls
  the spec's own `bind` function. The provider never compares tool names.
- `Value` is text, integer, boolean, or `Unsupported`.
- `notes` takes and returns plain text and knows no message type. The check for whether the index must be
  sent belongs to `provider::prompt`, beside the tool note's check. Note writes from the model go through
  `WorkspaceTools` like every other write.
- Adding a tool takes: a file with its `SPEC`, `bind`, and `run`; one `Invocation` variant; one arm in
  `runner.rs`; one arm in `Invocation::writes` (an exhaustive match, no wildcard); and one entry in the
  `SPECS` list. The provider and session do not change.
- A mapping from an HTTP status and body to a `ProviderError` is a pure function, tested without a
  server.
- `run_subagent` is the one tool the runner does not run. Only the session's callback starts a subagent, and only
  `subagent` builds a subagent's conversation. The runner refuses a direct call to it.
- `Turn` is built only in the provider's tool loop, and its shape is enforced by `Turn::new`.
- `Conversation` is the only holder of committed messages. `repl` reads them through
  `messages()`, `prompt_tokens()`, and `context_size` on the provider.
- The session owns the compaction budget (`over_budget`, `needs_compaction`). The provider reports
  `ContextFull`; it does not change history.
- `/context` prints the context message, then `<prompt tokens> / <context size>`. A failed size lookup is
  reported on the error stream.
- Tool output goes to the model as text. `render` prints answer text as it streams, prompt and thinking
  progress, and the end of each request. `repl` prints notices and errors. Approval prompts share the same
  output as `render`.
- Limits per module: 100 lines per function, 500 code lines per file, 10 files per directory.
- Recursion is allowed only within one module and only when bounded by a parameter (the directory walk
  is bounded by depth). A chain of turns is a loop, not recursion: a turn returns its after-turn failure
  text, and the loop that calls it decides whether to send it.
- A parent `mod.rs` declares its children and holds the registry. Types several siblings share live in a
  leaf module (`error.rs`, `tools/types.rs`).

## Open Problems

Each item is a gap between the design above and the code, or a decision the code makes that the design
does not allow.

Turn and history
- **Selecting a profile rewrites the enabled set.** A profile's tools line replaces every earlier choice,
  and a profile without one enables every tool, which undoes a `/tools disable`. `/profile` prints each tool
  whose state it changes, so the rewrite is no longer silent. Whether a profile without a tools line should
  leave the set alone instead is open: the user chose enable-all.
- **Profile listing and selection disagree.** `profile::names` lists every `.txt` file, including names
  `load` rejects (such as `my notes.txt`), so `/profile` shows a name it then refuses.
- **Profile text is unbounded.** `profile::load` reads the whole file. A large profile is committed and
  resent on every later turn.
- **No way to clear a profile.** Once chosen, a profile stays until another is chosen or the process ends.
  There is no "no profile" form, so its hook lines also stay active.
- **Narrowing the whitelist leaves disallowed notes in history.** Index messages are committed with their
  user message, and `read_note` results are committed too. After a profile narrows the whitelist, the
  summaries and content of notes it no longer allows stay in the conversation, and the model still sees
  them until compaction or a dropped turn removes them. The whitelist limits later reads, not what the
  model already has. Selecting a profile also changes the whitelist without a notice, as it does for tools.
- **Failed turns forget their writes.** A turn that writes and then fails (round limit, transport error,
  `ContextFullAfterChange`) commits none of its messages. The files stay changed, the next turn does not
  know it, and the user sees only the error. A failed turn must record the writes it applied, and its
  error must name the changed paths. The same holds for background tasks: a task started in a failed turn
  keeps running, and its id is lost with the turn.
- **Replayed reads lose output.** `read_background` advances the task's read position when it runs. If the
  turn is then retried (`ContextFull` before any write) or fails, the output that read returned never
  reaches the model, and the retry sees only what came after. Reads must take the offset from the
  conversation (see Invariants).
- **Turn shape is loosened.** `Turn::new` accepts a plain assistant message directly after the user
  message, and the test `summary_may_precede_tool_rounds` requires it. Nothing produces such a message:
  summaries live in `Conversation::compact`. The allowance and its test must go.
- **Summaries are discarded by their own check.** `summarize` returns `ContextFull` when the summary
  request's prompt is at 80%, even though the request succeeded. The caller then drops the oldest turn.
- **A drop is not a summary.** `Compaction::Dropped` removes history without a summary, so the one-summary
  rule does not hold after it. The `Compaction` outcome is defined in `repl.rs`, although `session` owns
  compaction.
- **Missing usage is zero.** When the server omits `usage`, the prompt count is stored as 0, and
  `/context` prints `0 / N` as if the conversation were empty. `drop_oldest_turn` also resets it to 0.
  The absence must be `None`, shown as unknown.
- **Repeated compaction is silent.** If the context is small or the summary large, every turn can trigger
  a full summary request, and nothing reports that compaction freed too little space.
- **Empty summaries are accepted by the REPL path.** An empty or whitespace summary is rejected by the
  provider, but the history it would replace is then dropped without a notice that says why.
- **A failed request leaves the status line open.** `send` returns on a read or parse error before it
  reports `Finished`, so the status line from prompt progress or thinking is not ended. The error notice then
  follows it on the same line. The REPL must end an open status line on every outcome.
- **Streamed text outlives a failed turn.** Answer text is printed as it arrives, before the turn is
  committed. If the turn then fails (for example a transport error mid-stream), the partial answer stays on
  screen while history does not hold it, and a retry prints it again. The REPL must mark an uncommitted
  answer as such, or hold it until the turn commits.
- **Rewritten history.** Past tool calls are resent from decoded values. `Unsupported` becomes `null`, and
  invalid JSON becomes `{}`, so the model sees its own calls differently from what it wrote. Keep the
  arguments string verbatim, or show the model the lossy form as an error.
- **Oversized output is committed.** A `list_directory` call at depth 5 has no entry or byte cap, and its
  full output is committed and resent on every later turn. A single oversized tool result can therefore
  break the rest of the session. The same applies to any single turn that grows past the window.
- **Unrecoverable long lines.** A line over 100 KB makes every `read_file` range that starts on it fail
  with "line N is longer than 100 KB", and the message does not say that no range can read that line.
- **Whole-file reads.** `read_file` reads the entire file and splits every line before applying its cap,
  so a range near the end of a large file costs the full file.

Notes
- **The notes layer reaches the session.** `notes::needed` takes `&[Message]`, so `notes` imports `session`,
  and `tools::notes` reaches the session through it, which the Rules forbid. The check belongs in
  `provider::prompt`, and `notes` takes plain text.
- **One bad note hides every note.** `notes::list` returns the first parse error for the whole folder, so
  `/notes`, `list_notes`, and the index all fail. The index error prints each turn, and the model is sent
  no index and is not told notes exist. A bad file should be reported by name, and the rest still listed.
  The parser also requires `---` followed by `\n`, so a note saved with CRLF line endings fails to parse.
- **The index reads every note in full.** `index` reads each note file to produce one summary line, every
  time it is built. The header alone is enough.
- **The model can delete notes before logging exists.** `delete_note` is a deletion the model can request.
  The Commands section says deletion tools wait for logging. The approval prompt is the only gate.
- **Note paths skip confinement.** `notes::path` checks the name but not the folder: a symlink named `notes`
  leads writes outside the working directory. `confine_new` should resolve the folder.
- **Note content is unbounded.** `create_note` and `update_note` accept any length, and `read_note` returns
  the whole note into the conversation.

Tool protocol
- **Two request formats.** A reply is requested as `<tool_call>` text, but earlier calls are resent as
  structured `tool_calls` with no `tools` field. The model sees its own calls in a form it is not asked to
  write. History should use the reply form, or the wire should use one form only.
- **Prose claims of tools are committed.** The grammar allows a plain reply such as `[Tool: run_powershell]`.
  Nothing runs, but the reply is committed, so later turns treat an action as done. The grammar cannot
  forbid this without forbidding ordinary text, so the turn must detect or label such replies.
- **The grammar does not constrain arguments.** Any JSON object passes the `arguments` rule. Bad arguments
  are found only in `tools::call`, after the model has chosen the call, and the model gets one error per
  round.
- **The grammar assumes a thinking block.** The root rule forces the closing `</think>` on every turn reply.
  It does not force the opening tag, so the chat template must open the block. A server or template that
  does not is unhandled.


Errors and the provider boundary
- **Misleading error for invalid JSON.** Invalid arguments decode to no arguments, so the model is told
  "missing 'path'" when its JSON was malformed. The error must name the malformed arguments.
- **Non-400 statuses look like connection failures.** A 5xx or other non-2xx reply is `Transport`, whose
  text says "check that the server is running". A `Status { status }` variant is needed for replies the
  server actually sent.
- **Empty server message.** `{"error":{"message":""}}` produces `Rejected("")`, and the user sees
  "the server rejected the request: ;". An empty or whitespace message must fall back to the raw body.
- **Overloaded `ModelNotFound`.** It means both "model not listed" and "listed without `n_ctx`". These
  need separate variants that name the model.
- **Stringly payloads.** `ToolError::Failed` and `ProviderError::Rejected` hold formatted text, and I/O
  causes are flattened, so callers and tests cannot match on the cause. `Transport` boxes an arbitrary
  error whose text can echo a response body. `notes`, `profile`, and `saved_sessions` return `String`
  errors for the same reason; they belong in enums in `error.rs`.
- **Error homes.** `ToolError` lives in `tools/types.rs`, not `error.rs`. `MAX_TOOL_ROUNDS` lives in
  `error.rs` but belongs to the provider.
- **No timeouts, one request at a time.** A stalled server blocks the REPL. Connect, send, and read
  timeouts are not configured. Each request builds its own `ureq` request rather than sharing an agent.

Boundaries that the design places elsewhere
- **Approval passes through the provider.** `Provider::complete` and `ToolRunner::run` take the approval
  callback. Approval belongs to the REPL's prompt, so the runner should be built with an approver and the
  provider's signature should not carry it. The subagent callback is carried the same way (see Subagents).
- **The budget threshold lives in the provider.** `provider::llama_cpp` imports `over_budget` and decides
  `ContextFull` from it. The session should pass a prompt limit in.
- **`repl` indexes the history.** `/context` reads `messages().first()`. `Conversation::context()` should
  be the only accessor.
- **Commands are not one table.** `commands.rs` parses the slash commands, but the help text is still written
  by hand beside them, so the two can drift apart.
- **Configuration is in `main`.** `main` loads `.env` and reads `LLAMA_API_KEY`. There is no `config`
  module. The endpoint and model are constants in `provider::llama_cpp`.
- **The source tree exceeds the Modularity limits.** `src/` holds 16 files (the limit is 10, and `turn.rs` from Structure would make 17): `after_turn.rs`,
  `before_turn.rs`, `file_commands.rs`, `shutdown.rs`, and `startup.rs` are the last five. `repl.rs` holds about 600
  code lines (the limit is 500). `cargo clippy --all-targets` reports warnings beyond the known one, including
  `chat_turn` taking 6 arguments after the `Streams` bundle (the limit is 7).
- **`Conversation` holds run configuration.** The before-turn lines, the after-turn lines, and the autosave folder are set on it by `main`.
  None is history. The run configuration (the working directory, the autosave folder, and the before-turn and after-turn lines)
  should be one value that `main` passes to `repl::run`.
- **`main` exits 0 when the REPL fails.** A stdin or stdout failure inside the REPL returns normally.

Writes
- **The approval text is unescaped.** `describe` prints the path, content, and edit text as received. Note
  names, summaries, categories, and content are printed the same way.
  Control characters and carriage returns can hide or rewrite what the user approves.
- **Approval and confinement are separate steps.** The description shows the path, and `confine_new`
  resolves it when the write happens, so a symlink changed in between goes unseen. `confine_new` checks
  ancestors with `Path::exists`, which follows symlinks, so a dangling symlink is skipped. No test pins
  that case.
- **Writes are not atomic.** `create_file` creates the file before writing it, and `edit_file` rewrites
  the file in place. A failure in between leaves a partial file. Both should write a temporary file and
  rename it. `/save` and autosave write a temporary file and rename it into place.
- **Session files are not shown as untrusted.** `/load` commits a file's messages as history with no
  mark that the file came from disk, possibly written by the model after an approved write.
- **Autosave files accumulate.** Each run that completes a turn leaves a session file, and nothing removes
  them, so the sessions folder grows without limit.
- **Autosave replaces its own file without checking.** The name is the first input's words, then the time in
  seconds, and the write replaces any file with that name. Two runs that start with the same input in the same
  second overwrite each other silently. `/save` refuses a taken name; autosave does not check.
- **Autosave keeps only the latest history.** Each completed turn rewrites the file with the whole history, so
  compaction and a dropped turn remove earlier turns from disk too. The file is a snapshot, not a log.
- **Autosave takes its name from the first completed turn.** A run whose first turn fails names its file from a
  later input. The name is chosen once, when the first turn completes.
- **A failed autosave is reported once per turn and nothing else.** The turn stays committed, and the next
  completed turn writes the whole history again.


Commands (`run_powershell`)
- **Commands are not logged.** Every approval, write, and command must be recorded before it runs, with
  its text, working directory, approval, and exit status. `run_powershell` records nothing. Deletion and
  further execution tools wait for this.
- **The command runs only on Windows.** `run_powershell` starts `powershell.exe` with no platform split.
  The process handling belongs behind one module boundary, with the Windows implementation behind it, so
  another platform adds an implementation rather than branches. Today `jobs.rs` holds the spawning and
  the `taskkill` calls; they move to `tools::process`, which uses a Job Object.
- **Interrupts orphan background tasks.** Ctrl+C ends the process without unwinding, so
  `WorkspaceTools::drop` does not run and the PowerShell processes keep running. The Job Object's
  kill-on-close flag is the fix; until it exists the invariant does not hold.
- **Tree kill misses orphans.** `taskkill /T` finds processes by their parent link at stop time. A process
  whose parent has already exited is not found, and keeps running after `kill_background` reports it
  stopped.
- **Background tasks are invisible to the user.** Tool output goes only to the model, so the user learns of
  a task only if the model mentions it. Nothing lists tasks, and the user cannot see a task's output.
- **Kill approval shows only the id.** `describe` prints "stop background task N". The command and state
  are not shown, so the user approves a number, not the process it stops.
- **Output is decoded per read.** `Output::since` converts each read's bytes lossily. A character split by
  a read boundary or by the 100 KB cap becomes replacement characters.

Profile hooks
- **Profile files can still be changed by approved shell commands.** The file tools refuse any path directly in the
  profiles folder (`PROFILES_FOLDER`, `is_profile_file`), and an approved `run_powershell` that names `profiles` says
  a profile may change. An approved command can still write a profile file, and the model could then add a `hook`
  line that runs at the next selection, turn, or exit. This is the same residual gap as for the command files.
- **Hook lines bypass the profile's tools line.** `run_command_file_line` does not check the enabled set, so a profile
  with `tools: read_file` still runs PowerShell through a hook. This is intended for command files (which also run with
  `run_powershell` disabled) and is stated in Invariants, but a profile that narrows the tools is not narrowing what
  its hooks can do. The user should confirm this decision.
- **Selection can split on an I/O error.** In the `Command::Profile` arm of `repl`, the instructions and the tool state
  change before `select_hooks` runs. If that call returns an I/O error through `?`, the new profile is selected while the
  previous profile's hook lines stay active. Hooks and instructions should change in one step.
- **Profile errors name no file.** A rejected header line reports only its text (`'hook ...' needs a kind and a command`),
  not the profile's name or the line number.
- **Hook lines are held in the history type.** `HookLines` lives in `session.rs`, and `Conversation` holds the selected
  profile's hooks. Both belong in `command_file` and in the REPL's selection state (see Open Problems, "Conversation
  holds run configuration").
- **Hook output is formatted twice.** `select_hooks` repeats the `Startup command:` block formatting of `startup.rs`.
- **Hook tests are missing.** No test shows that a profile's shutdown lines run (the test wrapper `shutdown::run` in
  `shutdown.rs` passes no profile lines, and `run_with_profile` is untested with lines), that a replaced profile's shutdown
  lines do not run, that `select_hooks` runs startup hooks and replaces the earlier hooks, or that a malformed hook header
  rejects the whole profile.

Subagents
- **Subagents are invisible.** Their output and status lines go to buffers that are discarded. The user sees only
  approval prompts, which name no subagent or profile. Follow-up failures at the limit and after-turn output are
  not shown either.
- **The provider tests tool names.** `provider::llama_cpp::run_call` matches `Invocation::RunSubagent`, checks the
  enabled set for the name `run_subagent`, and sets `wrote` itself, while `Invocation::writes` reports `false` for
  it. The Rules say the provider never compares tool names. The runner should refuse a disabled call and report
  the write, and the provider should pass the callback through.
- **Subagent work is unbounded.** A parent turn may start up to `MAX_TOOL_ROUNDS` subagents. Each may run up to
  `MAX_TOOL_ROUNDS` rounds in up to `FOLLOW_UPS` + 1 turns. No total is counted or reported.
- **A failed subagent forgets its writes.** Its conversation is discarded on error, and the parent sees
  `error: ...` with no changed paths. This is the failed-turn gap of Turn and history, now nested.
- **Replies have no size limit.** The final text enters the parent's history unchanged.
- **A subagent's shutdown hook does not run.** This is a decision to confirm, and the Definitions do not say so yet.
- **Parameter lists are at the limit.** `subagent::run` and `subagent::session` each take 7 parameters. Bundle the
  provider, the tool runner and the global hook lines into one value passed to both.
- **Tests are missing.** Nothing checks that the enabled set and whitelist are restored on an error path, that a
  `run_subagent` call sets the parent's `wrote` flag, that a disabled `run_subagent` is refused before the callback
  runs, or that `run_subagent` is refused inside a subagent.

Startup, shutdown, and before-turn
- **The model can change a command file.** The runner refuses `create_file` and `edit_file` writes to
  `startup.txt`, `shutdown.txt`, and `before-turn.txt`, and an approved `run_powershell` command that names one says
  so in the approval text. Any approved command can still write them, and the next launch, exit, or chat turn then runs the new lines
  with no prompt. Full control needs one of two decisions the user has not made: approval at each run, or a hash
  of the approved content kept outside the working directory.
- **Shutdown does not wait for slow lines.** After 30 seconds a shutdown command becomes a background task, and
  `WorkspaceTools::drop` stops it when the process exits. Its output is lost, and the next line runs at once.
- **Shutdown output is not shown.** Each command prints its `shutdown: COMMAND` line and its status line (the exit
  code, or the background task id). The output itself goes nowhere, so the user cannot check what it did.
- **The command-file names live in the tool runner.** `startup.rs`, `before_turn.rs`, `after_turn.rs`, and `shutdown.rs` import their names from `tools::runner`
  (`STARTUP_FILE`, `BEFORE_TURN_FILE`, `AFTER_TURN_FILE`, `SHUTDOWN_FILE`), and the runner's guard and approval text use them. The names belong in
  `command_file` (see Structure), which both can depend on without a cycle.
- **Startup output is not shown to the user.** Each command prints its `startup: COMMAND` line and its status
  line (the exit code, or the background task id). The output itself goes to the model only, so the user cannot
  check what it printed.
- **Startup output has no size limit and is never dropped.** A line adds up to its 100 KB output cap, and the block
  is resent with the first turn and every retry. If it does not fit, the turn fails with `ContextFull` after
  compaction, and the block stays pending, so every later line fails the same way until the process ends. Each
  command's output needs a cap, and a retry that still overflows should drop the block with a notice.
- **Startup text is not marked as coming from a file.** It reaches the model as user text, like the typed line.

- **Before-turn lines run on every turn.** The lines held from launch run before every chat turn, so each turn waits
  for their sum (up to 30 seconds per line) before its request starts.
- **A model-writable file runs without a prompt at the next launch.** An approved `run_powershell` can write
  `before-turn.txt`; the change takes effect at the next launch, with no prompt. The file is read once at launch, so
  a change does not run within the session it was made in. Remaining fix: approval at launch, or a hash of the approved
  content kept outside the working directory, as startup already needs.
- **A slow line starts a background task every turn.** A line still running after 30 seconds is left running as a
  background task, and the next turn runs the command again. Tasks have no count limit, so one slow line adds a
  process per turn.
- **A retry runs the lines again.** A turn that fails commits nothing, and the typed line sent again runs every
  before-turn line again: side effects repeat, and the first run's output is lost. Startup holds its block until
  commit. Before-turn needs the same hold, or a stated rule that each attempt is a new run.
- **Output is unbounded and committed.** Each line's output (up to 100 KB) enters history and is resent with every
  later request. The user sees only the status line. If the block does not fit the context, compaction cannot
  recover, because each attempt runs the command again and produces the same block, so every turn fails until the
  file is edited or the process ends.
- **Before-turn, after-turn, and startup repeat one wrapper.** `before_turn.rs`, `after_turn.rs`, and `startup.rs` differ only
  in the file name, the label, and the block prefix or failure filter, and `shutdown.rs` has the same shape. `main` repeats the
  load-and-store match for before-turn, after-turn, and startup. Loading and the block formatting belong in `file_commands`.
- **A follow-up that fails by overflow ends the chain without saying why.** A follow-up whose turn still reports
  `ContextFull` after compaction prints the generic error (repl.rs, `Err` arm of `chat_turn`), and the failing line's
  result is dropped. The error does not say that an after-turn line is still failing. A test pins the stop
  (`follow_up_that_overflows_ends_the_chain`).
- **After-turn output is not shown.** Only the status line is printed. The output that explains a failure goes to the model only.
- **A slow after-turn line runs on every turn.** As for before-turn, a line still running after 30 seconds becomes a background
  task, which is not a failure, and the next turn starts the command again.

Security-relevant gaps are listed under Security.

## Security

Trust boundaries:
- **Model output** is untrusted. It is printed to the terminal and may request tool calls. Tool names
  and arguments are validated like any other input.
- **Tool arguments** are untrusted. A path may be absolute, contain `..`, or name a symlink that leads
  outside the working directory.
- **Responses from the endpoint** are untrusted input to the parser: malformed JSON, unexpected shapes,
  and oversized bodies.
- **File and directory names** under the working directory are untrusted text. They can contain
  instructions to the model.
- **Standing instructions (`AGENTS.md`)** are untrusted text that the user may not have written. An approved
  write can change the file, and the new text then shapes the model's behaviour in every later session, since
  the file is read at each session start and sent with every request. A write to it is a persistence path
  for injected instructions.
- **Profile files** are untrusted text, and they are command files too. They sit in `profiles/` under the working
  directory, which the file tools do not guard, so an approved write can change them. Their text reaches the model
  verbatim. Their `notes:` line sets which notes the model can see, so a profile file also decides what note text
  reaches the model. Their `hook` lines run with the user's full permissions and no prompt: `startup` hooks at
  selection, `before-turn` and `after-turn` hooks on every chat turn, and `shutdown` hooks at exit. Their output goes to
  the model (except shutdown). A profile file therefore has the trust of `startup.txt`, and the controls below for
  command files apply to it.
- **Notes** are text the model writes (after approval) or the user writes. The index and `read_note` results
  put their text before the model in later sessions, so a note is a persistence path for injected
  instructions, like `AGENTS.md`.
- **Session files** are JSON histories under `sessions/`. An approved write can create or change one, so the
  model can write a session the user later loads. `/load` commits its messages as history, so a session file
  is a persistence path for injected instructions and for forged tool results.
- **After-turn output** is untrusted text that can start model turns without a typed line. A failing line's command and
  output become a user message, up to `FOLLOW_UPS` times in a row. An instruction in a file or page the command reads
  therefore reaches the model unprompted. Each write those turns request still needs approval.
- **Command files** (`startup.txt`, `before-turn.txt`, `after-turn.txt`, `shutdown.txt`, and profile files, see above) are untrusted text in the same way as `AGENTS.md`. The model
  can change them through an approved write, and their lines run with the user's full permissions at every
  launch and exit, and before every chat turn for `before-turn.txt`, with no prompt (Open Problems). Startup and
  before-turn output then goes to the model, where a file or page a command reads can carry instructions into later
  turns. Shutdown output goes
  nowhere, so a shutdown line can act without the model or the user seeing its result.
- **Subagent replies** are model output from a run under another profile's instructions. The parent model reads
  them as a tool result, so they are untrusted text that can carry instructions into the parent turn. A subagent's
  writes reach the parent's approval prompt with nothing naming the subagent or its profile.
- **The API key** lives in `.env` (git-ignored) and in the environment.

What untrusted input can reach:
- Model text reaches the terminal, where escape sequences can rewrite the screen or hide text.
- Read tools expose files under the working directory to the model. Write tools change them, each after
  the user's approval. `run_powershell` executes a command the user approved, with the user's full
  permissions and no path confinement.
- Tool results and summaries go back to the model. An injected instruction in a file name or in a summary
  persists through later turns, because committed history is resent.
- Error text may echo a server's 400 message or raw body, which must pass through the same sanitization as
  model text.

Controls:

| Control | Status |
| --- | --- |
| Path confinement for reads and writes | Met. A symlink swapped in after approval is not caught (Open Problems). |
| Write approval, default no | Met. Description is not escaped (Open Problems). |
| Terminal sanitization of streamed model text, approval text, and error text | Missing. Streamed text is printed chunk by chunk, so the filter must work across chunk boundaries. |
| API key never printed, logged, or put in errors | Partly met. Error paths have not been audited. |
| Plain HTTP refused unless the endpoint is loopback | Missing. The endpoint is a loopback constant. |
| Size limits on user lines, profile files, and response bodies | Missing. Profile files are read whole (Open Problems). |
| Profile names restricted to letters, digits, `-`, `_` | Met. A name cannot leave the profiles folder. A symlink inside the folder is still followed. |
| Size limits on tool output | `read_file` and background task output. `list_directory` has none. |
| Limits on commands: time, process tree, output | Partly met. A foreground command waits at most 30 seconds, then becomes a background task. Stopping a task ends every process in its Job Object. Output is capped at 100 KB per task. Background tasks have no count limit. Interrupts and orphaned processes are not covered (Open Problems). |
| Approval shows what a stop will end | Missing. `kill_background` shows only the id (Open Problems). |
| The user can see what is running | Missing. No listing of background tasks (Open Problems). |
| Tool results and summaries marked as untrusted data | Missing. |
| Tools run only when enabled | Met. The grammar constrains the reply and the runner refuses a disabled call. |
| Plain text cannot run a tool | Met. Only the tool call form runs. A prose claim of a tool is committed without running (Open Problems). |
| Arguments checked per tool | Met in `tools::call`, after the grammar. The grammar accepts any object (Open Problems). |
| Enabling a tool | Accepted. `/tools enable` is the user's own action; each write still asks for approval. |
| Profile files limiting the notes the model may use | Partly met. The runner refuses a disallowed note before approval and the index omits it. Earlier index messages and note results stay in history (Open Problems). The user's note commands are not limited, by design. |
| Profile files setting the enabled set | Partly met. A profile's tools line is checked against the catalogue, and selecting a profile is the user's action. Selection re-enables every tool when the profile has no line, and reports nothing (Open Problems). Its hook lines run whatever the enabled set is (Open Problems). |
| Profile hook lines run only while their profile is selected | Met. Selecting another profile replaces them at once, and shutdown reads the current ones. A failed selection keeps the old ones. The I/O-error split is open (Open Problems). |
| Profile hook lines run only from a file the model cannot write | Partly met. The file tools refuse the profiles folder, and an approved command that names it says a profile may change. An approved command can still write a profile file (Open Problems). |
| Profile hook lines bounded in time, count, and output | Missing, as for before-turn and after-turn lines (Open Problems). |
| Logging of approvals, writes, and commands | Missing. Commands, including startup commands, are not logged (Open Problems). |
| Command-file commands run without approval only from a file the model cannot write | Partly met. The file tools refuse `startup.txt`, `shutdown.txt`, `before-turn.txt`, and `after-turn.txt` by name, but not profile files (Open Problems), ignoring trailing dots and spaces and `:` streams. An approved `run_powershell` command that names one says so, but an approved command can still write any of them, and for `before-turn.txt` the change runs at the next launch with no prompt (Open Problems). |
| Command-file lines are not gated by the enabled tool set | Met. Command-file lines run through `run_command_file_line`, which skips the enabled-set check and keeps the file guard. |
| Startup, before-turn, after-turn, and profile hook output marked as untrusted data | Missing. |
| Before-turn and after-turn commands bounded in time, count, and output | Missing. Each line waits up to 30 seconds on every turn, a slow one starts a background task each turn, and its output is unbounded (Open Problems). After-turn lines add the same wait after every chat turn. |
| Before-turn lines not run again by a retry | Missing. A retried line runs them again (Open Problems). |
| After-turn follow-ups bounded, and approved per write | Partly met. At most `FOLLOW_UPS` follow-ups per typed line, in a loop. Each write they request still asks for approval. The user chose no approval for the follow-ups themselves, and the failure text reaches the model without a typed line (Security). The count disagrees with its message (Open Problems). |
| Subagent started only when `run_subagent` is enabled, and never by a subagent | Met. The provider checks the enabled set, the runner refuses a direct call, and `run_subagent` is disabled inside a subagent. The name check in the provider is an Open Problem. |
| Subagent writes approved with the subagent and profile named | Missing. The prompt shows the write only (Open Problems). |
| Bounds on subagents per parent turn, and on their turns | Missing (Open Problems). |
| Subagent reply size limit | Missing (Open Problems). |
| Subagent output and failures shown to the user | Missing (Open Problems). |
| Subagent profile limits (tools, notes) | Met. They come from the profile and are restored afterwards. Its hooks run without a prompt, as for any profile (Open Problems). |
| Environment disclosure (working directory and standing instructions sent every turn) | Missing. Only opt-in fields would be sent; today the path and the whole `AGENTS.md` are always sent. The notes index is sent with it. |
| Size limit on standing instructions | Missing (Open Problems). |
| Size limit on note content | Missing (Open Problems). |
| Note names restricted to letters, digits, `-`, `_` | Met. A name cannot leave the notes folder. A symlink named `notes` is still followed (Open Problems). |
| Notes index and note text marked as untrusted data | Missing. |
| Note writes approved like other writes, including the user's own note commands | Met. `/note create` and `/note delete` go through the runner. |
| Session writes approved like other writes | Met. `/save` asks for approval before it writes, and refuses a name that is taken. It does not go through `WorkspaceTools` (no `Invocation`). |
| Session files checked before they are loaded | Met. `/load` checks each turn before it replaces the history. |
| Session names restricted to letters, digits, `-`, `_` | Met. A name cannot leave the sessions folder. |
| Writes to `AGENTS.md` shown as such | Missing. The approval text reads like any other write, and no warning says the file shapes later sessions. |
| Data exposure (directory listings sent to the endpoint) | Accepted. History reaches disk unredacted through `/save` and autosave, including tool results and command output (Open Problems). |
| Autosave writes without approval | Accepted by design, as the one exception to Write. It writes only `sessions/NAME.json`, and does not check for an existing file of that name (Open Problems). |

## Future Work

- Per-tool argument rules in the grammar, generated from each `ToolSpec`'s parameters, so the server
  rejects bad arguments before `tools::call` sees them.
- Route each tool's arguments through `tools::call` in tests, so the path from raw arguments to
  `Invocation` is tested as one unit.
- Make `ToolSpec`, `bind`, and each `SPEC` visible only inside `tools`.
- Sanitization of streamed text per chunk (see Security and Open Problems).
- One output cap and one background-task count limit, shared by startup, before-turn, and shutdown.
- Configuration from a file or environment, with overrides for endpoint, model, timeouts, and the
  history and compaction budgets.
- A `/compact` report that shows the summary and how many turns and tokens it replaced.
- Token-aware trimming of old turns, as the fallback when a summary does not fit, in place of dropping the
  oldest turn outright.
- A `/jobs` command that lists background tasks with their command, state, and age, and a way to read a
  task's output from the terminal, so the user can see what is running before approving a stop.
- Deletion and further execution tools, only after logging is implemented.
- A `/note edit NAME` form that changes a note's content through the runner's approval, so the user can
  correct what the model wrote.
- A `/profile` form that clears the selection, and a `/profile` listing that shows the selected profile. Clearing stops its hook lines too.
- Subagent output shown to the user in a labelled block, and approval prompts that name the subagent and profile that
  asked for a write.
- One command-file policy table in `command_file`: for each of the four files, when it runs, where its output goes, what
  counts as failure, and its line and output limits. Startup, before-turn, after-turn, and shutdown then differ only by
  that table, and `main` makes one call per file. Profile hooks use the same table, one entry per hook kind.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn sends the whole conversation, and each tool round in a turn resends it. Cost grows with
  history length.
- Compaction is a full generation over the conversation. It runs only at the budget.
- The REPL blocks on each request, and input typed during a long generation waits in the terminal.
- Thinking runs before any answer text appears, and a long thinking block (up to the 8192-token reply cap)
  shows only a counter until the answer starts.
- A directory listing walks the tree synchronously with no entry cap.
- A foreground command blocks the REPL for up to its 30-second wait. Background tasks have no count limit,
  and each keeps up to 100 KB of output, so many long-running tasks use memory in proportion.
- Each request builds a new `ureq` request. One shared agent would reuse connections.
- `/save` and `/load` encode and decode the whole history as pretty-printed JSON in one string. A session is
  about as large as the conversation it holds, and `/load` reads all of it before the turn check.
- Before-turn lines run before every chat turn, so each turn waits for their sum (up to 30 seconds per line) before its
  request, and their output is resent with every later request. A selected profile's before-turn and after-turn hooks add
  to these waits.
- After-turn lines run after every chat turn, and a failing line can cause up to `FOLLOW_UPS` more turns, each with its own
  before-turn run and request.
- The standing instructions are resent with every request, so a large `AGENTS.md` adds prompt tokens to every
  turn and to every tool round.
- Startup runs its lines one after another before the first prompt appears, each up to its 30-second wait. A
  file with several slow lines delays the REPL by their sum. Shutdown does the same before the process exits.
- The notes index is resent whenever notes change, one line per note. Building it reads every note in full
  (Open Problems), on each user message that checks it.
- Each subagent gathers its environment (reading `AGENTS.md`) and sends its own context, so each start costs a full
  first request before any tool work. Its turns repeat the parent's before-turn and after-turn waits.
- Grammar-constrained decoding checks each token against the grammar. Measure its cost against an
  unconstrained request before adding per-tool argument rules.
