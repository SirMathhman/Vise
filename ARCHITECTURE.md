# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server with an OpenAI-compatible
`/v1/chat/completions` endpoint. The model can read and write files under the working directory
through tools, and runs PowerShell commands; the user approves every write.

This document describes the design, and lists once where the code does not yet meet it (Open
Problems). It is a reference, not a changelog: finished work is removed, not annotated.

## Definitions

- **Turn**: one user line, the tool exchanges the model makes while answering it, and the final assistant
  reply. A turn is committed whole or not at all. A follow-up turn (see After-turn) is a turn of its own,
  whose user message is the failure text of the after-turn commands.
- **Message**: one variant per role: `System`, `User`, `Assistant` (content and the tool calls it requested),
  and `Tool` (content and the id of the call it answers).
- **Conversation**: the committed history sent to the model on every turn, plus the run's configuration.
  Only `session` changes the history.
- **Context message**: the leading system message: the working directory, then the standing instructions if the
  working directory holds an `AGENTS.md`. It is gathered at startup, sent on every turn, and never removed by
  compaction.
- **Standing instructions**: the text of `AGENTS.md`, read once at session start. A change to the file takes
  effect only in a new session.
- **Provider**: a backend that turns a conversation into a turn, reports the context size, writes summaries,
  and names the model its requests use. It lists the models the server offers and switches between them.
  llama.cpp is the only provider.
- **Model**: the id every request names. It starts as the built-in model, or as the saved default model.
  `/model NAME` changes it to an id the server lists.
- **Default model**: the name kept in `model.txt` in the working directory, written by a successful `/model NAME`
  and applied at launch.
- **Context size**: the token capacity of the model in use, read from the server for that model. A switch reads it
  as part of the switch, so the size and the model change together.
- **Prompt tokens**: the prompt token count the server reports for the last request of a turn.
- **Compaction**: replacing older history with a summary the model wrote. The result keeps the context message,
  one summary (an assistant message with no tool calls), and the last two turns. It runs on `/compact`, and before
  a turn when the last prompt tokens reach 80% of the context size.
- **Tool catalogue**: the text listing every tool and its arguments. It is joined to the leading system message of
  each request only, never stored, and it lists disabled tools too, so it does not change during a session.
- **Enabled tools**: the tools the model may call. The runner holds the set. `/tools`, and a selected profile's tools
  line, change it. Each request's grammar is built from it.
- **Tool note**: the line `[Tools enabled: ... Tools disabled: ...]`, which states the enabled set to the model.
- **Tool call form**: a reply consisting of `<tool_call>`, a JSON body with `name` and `arguments`, and
  `</tool_call>`. It is the only reply form that runs a tool.
- **Write**: a call that changes the filesystem, or starts or stops a program. These are the tool calls
  `create_file`, `create_directory`, `edit_file`, `run_powershell`, `kill_background`, `create_note`,
  `update_note`, `delete_note`, and `run_subagent`, and the user's commands `/note create`, `/note delete`,
  `/save`, and `/model NAME`. A write runs only after the user approves it, whoever asked. Exceptions are
  autosave (see Session), and the command lines (see Command files and hooks). A declined write is reported
  to the model as an error and changes nothing.
- **Note**: a named file, `notes/NAME.md`, starting with a `---` header of one `summary:` line and one `category:`
  line, then the content. Notes persist across sessions.
- **Notes index**: the list of every allowed note's name, category, and summary, or `[Notes]` followed by `(none)`.
- **Session**: the history after the system context, saved as `sessions/NAME.json` by `/save` and replaced by
  `/load`. Autosave writes the history after each completed turn to a session named from the run's first input
  and the time, so each run has its own file.
- **Profile**: a named set of instructions in `profiles/NAME.txt`, selected with `/profile NAME`. Its text, under a
  heading that names it, is prepended to the next user message only. Its optional header lines, in any order, are
  `tools:` (the tools it allows), `notes:` (the notes the model may use), and `hook KIND: COMMAND` (see Profile hooks).
- **Note whitelist**: the note names the model may use, set by the selected profile's `notes:` line, or all notes.
  It limits the notes index, `list_notes`, and the four note tools. It does not limit the user's `/notes` and `/note`.
- **Command file**: a file of PowerShell command lines in the working directory, run without a prompt:
  `startup.txt`, `shutdown.txt`, `before-turn.txt`, or `after-turn.txt`. The file tools refuse to change them.
- **Startup**: the lines of `startup.txt`, run once, in order, before the first prompt. Each command's block (its
  text, its output and exit status, or its error) is held until a turn commits, and sent with that turn's message.
- **Shutdown**: the lines of `shutdown.txt`, run once, in order, after the REPL ends: at `/exit`, at end of input, or
  after a stdin read failure. Their output goes to the screen only, so nothing they do is saved in a session.
- **Before-turn**: the lines of `before-turn.txt`, run before every chat turn (not slash commands). Their block is
  prepended to that turn's message after the startup text, and is committed with the turn.
- **After-turn**: the lines of `after-turn.txt`, run after each chat turn commits (not slash commands). Each line's
  output goes to the model. A line fails when its result's first line is `exit code: N` with N not zero. The failing
  lines form the next user message, which starts a follow-up turn.
- **Profile hook**: a `hook KIND: COMMAND` line of the selected profile, where KIND is `startup`, `shutdown`,
  `before-turn`, or `after-turn`. It is a command line of the matching kind, held only while its profile is selected.
- **Subagent**: a turn run under a named profile in a fresh conversation, started by the model with `run_subagent`
  (`profile`, `task`). It takes the profile's instructions, tools, notes, and hooks, cannot start another subagent,
  and returns only its final reply to the parent. It is never autosaved.
- **Background task**: a PowerShell command that keeps running after its tool call returns. It gets an id, its output
  is collected while it runs, and the model reads it with `read_background` and stops it with `kill_background`.
- **Event**: a progress report from the provider during one request: prompt-processing progress, a running
  thinking-token count, a piece of answer text, or `Finished`. Events are for display only.
- **Wire type**: a struct matching the JSON shape of a provider request or response. Wire types never leave
  `provider::llama_cpp`.

## Invariants

### Turns and history

- A successful turn appends its user message, its tool exchanges, and its reply together. A failed turn leaves the
  conversation as it was. It does not undo the files the turn changed (see Open Problems).
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
  Compaction or a dropped turn that removes it causes it to be sent again.
- A profile's text is sent with the next user message whenever the history does not carry it, so a failed turn keeps it
  for the retry. Once committed, its text stays in history until compaction or a dropped turn removes it.

### Requests, replies, and the tool loop

- Each request has no `tools` field. It carries a grammar built from the enabled tools. The grammar fixes the reply to a
  thinking block followed by plain text, or one tool call to an enabled tool. Plain text cannot contain `<tool_call>`.
- Only a tool call form runs a tool. A plain-text reply that names a tool runs nothing.
- A disabled tool does not run, even if a reply names it: the grammar stops its generation, and the runner refuses it.
- The model always knows the enabled set from the history it is sent. A user message carries the tool note whenever the
  history does not state the current set.
- Streamed answer text is shown only after the start of the reply rules out a tool call. A reply that is a tool call is
  never shown as text.
- Thinking is shown as a running token count only. Its text is never shown.
- Prompt progress and thinking share one status line, rewritten in place. Answer text or the end of the request ends it.
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

- A write runs only after the user approves a description of it. The default is no: only `y` or `yes` approves. This holds
  for the user's note commands, `/save`, and `/model NAME`, as for model calls.
- The approval text for `kill_background` names the task's command and whether it is still running, not only its id.
- Enabling or disabling a tool changes no committed message, and enabling a tool does not approve its writes.
- The note whitelist is checked before approval. A note tool naming a note outside it is refused, so the user is never asked
  to approve a write to a note the model may not use. The index and `list_notes` list only the allowed notes.
- A note name is validated like a profile name, so it cannot leave the notes folder. `create` fails if the note exists;
  `update` and `delete` fail if it does not. A summary or category is one non-empty line.
- Paths: a read resolves its path with `confine` (the path must exist and lie under the working directory). A write
  resolves its path with `confine_new`, which resolves `..` lexically and requires the deepest existing ancestor to lie
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
- `/context` prints the context message, then `<prompt tokens> / <context size>`. A failed size lookup is reported on the
  error stream.

### Sessions, notes, profiles

- A session is saved as `sessions/NAME.json`, and its name follows the profile name rule, so it cannot leave the folder.
  `/save` refuses a name that already has a session, and asks for approval first. `/load` replaces the history, keeps the
  current run's context message, and resets the prompt token count.
- Autosave is the one write without approval. It writes only `sessions/NAME.json`, after each completed turn, and the name
  is chosen once per run, when its first turn completes.
- A profile is chosen by name only. The name must be letters, digits, `-` or `_`, so it cannot leave the profiles folder.
- Selecting a profile sets every tool's state: the enabled set becomes exactly the profile's tools line, or all tools when it
  has none. It replaces the note whitelist with the profile's notes line, or all notes when it has none. The change is made
  when `/profile NAME` runs, and it replaces any earlier `/tools` choices.
- A profile's header is checked before anything changes. A failed selection (an unknown name, a bad header line, or an unknown
  tool or note) leaves the instructions, tools, notes, and hooks as they were.
- Notes, sessions, and profiles are plain files. Only the names in the Definitions say what they may contain.

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
  every invariant of this section. Follow-up turns form a loop in `repl`, not recursion. At most `FOLLOW_UPS` (5) follow-ups
  follow one typed line. A follow-up that fails (including a `ContextFull` that compaction does not cure) ends the chain and is
  reported.
- Selecting a profile replaces the hook lines held from the one selected before, in the same step that changes its instructions.
  The lines of the previously selected profile never run after another profile is selected. The selected profile's `startup`
  hooks run at once, and their output reaches the model with the next message.
- The file tools refuse any change to a command file or to a file directly in the profiles folder, whatever the spelling of its
  name. An approved `run_powershell` can still change them, and its approval text says so when the command names one.

### Subagents

- A subagent runs in a fresh `Conversation` built from its own environment gathering, never the parent's. Its profile is
  applied before its first turn: tools, then note whitelist, then hooks, whose startup lines run then. `run_subagent` is
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

## Structure

```
src/
  main.rs            wiring: reads .env and LLAMA_API_KEY, takes the working directory, builds the provider and the
                     tool runner, applies the saved default model, loads the command files, runs the REPL, then shutdown.
                     Fatal startup errors go to exit_with.
  repl.rs            the input loop over generic BufRead and Write. Parses and runs slash commands, hands each chat
                     line to `turn`, runs the follow-up turns, asks for approval of writes, and writes replies and notices.
  commands.rs        parses a slash command into `Command`, and holds the help text (no I/O)
  turn.rs            runs one turn: `run_turn` (compaction, and the one retry on ContextFull), `prepare_message`
                     (before-turn, startup, profile, and notes index), `apply_whitelist`, `select_hooks`, and `hook_lines`.
                     It takes the approval and subagent callbacks as parameters.
  subagent.rs        runs one subagent: a fresh conversation under a profile, its turns and follow-ups, and the restore of
                     the parent's enabled tools and notes on every exit.
  session.rs         Message, Turn (checked shape), Conversation (committed history, prompt tokens of the last committed
                     turn, compaction, drop_oldest_turn, the autosave folder and name, startup text, the before-turn and
                     after-turn lines, and the selected profile's hook lines as `HookLines`), over_budget (80%)
  saved_sessions.rs  the sessions folder: saves a history as JSON, and lists and loads sessions by a validated name.
                     Tool call arguments are stored as JSON values; the context message is not stored.
  profile.rs         lists the profiles folder's `.txt` files, loads one by a validated name, and parses its header lines
                     (`tools:`, `notes:`, and `hook KIND: COMMAND`) from its instructions
  notes.rs           the notes folder: one file per note. Reads, creates, updates, deletes, and lists notes, and builds the
                     index text. Listing takes an optional allowed set of names.
  default_model.rs   the default model's name in `model.txt`: loads and saves it as plain text
  startup.rs         runs `startup.txt` before the first prompt, and returns its blocks as one text (or None)
  before_turn.rs     runs `before-turn.txt` before each chat turn, and returns the block the turn's message carries
  after_turn.rs      runs `after-turn.txt` after each committed chat turn, and returns the failing ones as the next message
  shutdown.rs        runs `shutdown.txt`, then the selected profile's shutdown hooks, after the REPL ends
  file_commands.rs   runs the lines of one command file in order through the tool runner, printing each line and its status
  render.rs          displays provider Events: one status line, answer text, and the end of each request. Owns the output
                     the answer and the approval prompt share.
  environment.rs     gathers host facts as plain data: the working directory, and the standing instructions from `AGENTS.md`
  error.rs           ProviderError, SessionError, MAX_TOOL_ROUNDS
  provider/
    mod.rs           declarations only
    types.rs         trait Provider: complete, complete_streaming (default: calls complete and reports nothing),
                     context_size, summarize, model, models, set_model (the last three refuse by default); enum Event
    llama_cpp.rs     the HTTP client; wire structs; the streamed reader; the Stream that holds back answer text until the
                     reply's kind is known; the tool-round loop; the 400 mapping; the `/v1/models` lookup, shared by the
                     context size, `models`, and `set_model`; the model name, in a cell, copied out before each request;
                     conversion between JSON arguments and Values
    grammar.rs       builds the GBNF grammar from the enabled tool names
    prompt.rs        the tool catalogue text, from every ToolSpec; the tool note; the notes index message and the check
                     for whether it is needed
  tools/
    mod.rs           registry: specs(), call(name, values) -> Invocation; declares its children
    types.rs         ToolSpec, Param, ParamType, Value, Arguments, Invocation, ToolCall, ToolError, ToolRunner
    runner.rs        WorkspaceTools: runs an Invocation. It refuses a disabled tool, a note outside the whitelist, and a
                     file-tool write to a command file or the profiles folder; asks for approval first when it writes;
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

## Dependencies

An arrow means "may depend on". Dependencies only point one way; there are no cycles.

```
main -> the wiring of every top-level module
repl -> turn, subagent, commands, session, provider::types, tools, profile, notes, saved_sessions, default_model,
        after_turn, render, environment, error
turn -> session, provider::types, tools, profile, notes, before_turn, after_turn, file_commands, error
subagent -> turn, session, profile, environment, provider::types, tools, after_turn, error (not repl)
startup, before_turn, after_turn, shutdown -> file_commands, tools::runner, tools::types
file_commands -> tools::runner, tools::types
profile -> session (HookLines), notes (valid_name), environment, tools::runner, tools::specs
saved_sessions -> session, tools::types, error
session -> environment, tools::types, error
provider::llama_cpp -> provider::types, provider::grammar, provider::prompt, session, tools, error
provider::prompt -> session, tools
provider::types -> session, tools::types, error
render -> provider::types
notes -> session (the check whether the index is needed, see Open Problems)
default_model -> std only, a leaf: it knows neither the provider nor the session
commands, environment, error -> std only
tools -> notes; no provider, session, HTTP, or serde
```

## Rules

- `provider::llama_cpp` is the only module that knows HTTP, `ureq`, the endpoint, the wire shapes, or the JSON form of tool
  specs and calls. Only `provider::grammar` knows the call syntax as a grammar, and only `provider::prompt` knows the
  catalogue's text and the tool note's text.
- The model name is held by `provider::llama_cpp` alone. `default_model` and `repl` pass a name in through `Provider::set_model`,
  and the provider never reads or writes `model.txt`. The name is copied out of its cell before a request starts.
- The provider sends the grammar built from `ToolRunner::enabled()` on every request, and never a `tools` field. The provider
  never compares tool names: refusing a disabled tool is the runner's job (see Open Problems for the one exception).
- `tools` never parses JSON and never imports the provider or the session. The provider decodes a model's arguments into plain
  `Value`s (text, integer, boolean, or `Unsupported`), and passes them with the tool name to `tools::call`, which checks the
  values against the spec and calls its `bind`.
- `notes` takes and returns plain text. Note writes from the model go through `WorkspaceTools` like every other write.
- Adding a tool takes: a file with its `SPEC`, `bind`, and `run`; one `Invocation` variant; one arm in `runner.rs`; one arm in
  `Invocation::writes` (an exhaustive match, no wildcard); and one entry in the `SPECS` list. The provider and session do not change.
- `run_subagent` is the one tool the runner does not run. Only the session's callback starts a subagent, and only `subagent`
  builds a subagent's conversation.
- `Turn` is built only in the provider's tool loop, and its shape is enforced by `Turn::new`.
- `Conversation` is the only holder of committed messages. `repl` reads them through `messages()`, `prompt_tokens()`, and
  `context_size` on the provider.
- Tool output goes to the model as text. `render` prints answer text as it streams, prompt and thinking progress, and the end of
  each request. `repl` prints notices and errors. Approval prompts share the same output as `render`.
- Limits: 100 lines per function, 500 code lines per file, and 10 files per directory.
- Recursion is allowed only within one module, and only when bounded by a parameter (the directory walk is bounded by depth).
  A chain of turns is a loop, not recursion.
- A parent `mod.rs` declares its children and holds the registry. Types several siblings share live in a leaf module
  (`error.rs`, `tools/types.rs`).

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
- **Profile listing and selection disagree.** `profile::names` lists every `.txt` file, including names `load` rejects (such as
  `my notes.txt`), so `/profile` shows a name it then refuses.
- **Profile text is unbounded.** `profile::load` reads the whole file. A large profile is committed and resent on every later turn.
- **No way to clear a profile.** Once chosen, a profile stays until another is chosen or the process ends, and its hook lines
  stay active.
- **Turn shape is loosened.** `Turn::new` accepts a plain assistant message directly after the user message, and the test
  `summary_may_precede_tool_rounds` requires it. Nothing produces such a message. The allowance and its test must go.
- **Summaries are discarded by their own check.** `summarize` returns `ContextFull` when the summary request's prompt is at 80%,
  even though the request succeeded. The caller then drops the oldest turn.
- **A drop is not a summary.** `Compaction::Dropped` removes history without a summary, so the one-summary rule does not hold after it.
- **Missing usage is zero.** When the server omits `usage`, the prompt count is stored as 0, and `/context` prints `0 / N` as if the
  conversation were empty. The absence must be unknown, not zero.
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
- **One bad note hides every note.** `notes::list` returns the first parse error for the whole folder, so `/notes`, `list_notes`,
  and the index all fail. A bad file should be reported by name, and the rest still listed. The parser also requires `---` followed
  by `\n`, so a note saved with CRLF line endings fails to parse.
- **The index reads every note in full.** It reads each note file to produce one summary line, every time it is built. The header
  alone is enough.
- **Note paths skip confinement.** `notes::path` checks the name but not the folder: a symlink named `notes` leads writes outside the
  working directory.
- **Note content is unbounded.** `create_note` and `update_note` accept any length, and `read_note` returns the whole note.

### Tool protocol

- **Two request formats.** A reply is requested as `<tool_call>` text, but earlier calls are resent as structured `tool_calls` with no
  `tools` field. History should use the reply form, or the wire should use one form only.
- **Prose claims of tools are committed.** The grammar allows a plain reply such as `[Tool: run_powershell]`. Nothing runs, but the
  reply is committed, so later turns treat an action as done.
- **The grammar does not constrain arguments.** Any JSON object passes the `arguments` rule. Bad arguments are found only in
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
  and tests cannot match on the cause. `Transport` boxes an arbitrary error whose text can echo a response body. `notes`, `profile`,
  and `saved_sessions` return `String` errors for the same reason.
- **Error homes.** `ToolError` lives in `tools/types.rs`, not `error.rs`. `MAX_TOOL_ROUNDS` lives in `error.rs` but belongs to the provider.
- **No timeouts, one request at a time.** A stalled server blocks the REPL. Connect, send, and read timeouts are not configured.

### Layering and configuration

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
- **`repl` indexes the history.** `/context` reads `messages().first()`. `Conversation::context()` should be the only accessor.
- **Commands are not one table.** `commands.rs` parses the slash commands, but the help text is written by hand beside them.
- **Two sources for one setting.** The endpoint is a constant in `provider::llama_cpp`. The model starts as that module's constant, and
  `default_model` reads a second source, `model.txt`. There is no `config` module.
- **`Conversation` holds run configuration.** The before-turn and after-turn lines, the startup text, the autosave folder, and the
  selected profile's hooks are set on it by `main` or the REPL. None of them is history. They should be one value that `main` passes
  to `repl::run`.
- **Hook lines are held in the session module.** `HookLines` lives in `session.rs`, and the selected profile's lines are held by
  `Conversation`. They belong with the REPL's selection state, not the history.
- **The source tree exceeds the Modularity limits.** `src/` holds 18 files (the limit is 10). `repl.rs` and `provider/llama_cpp.rs`
  are over the 500-code-line limit. `cargo clippy --all-targets` reports warnings beyond the known one, including `chat_turn`'s
  arguments, and `subagent::run` and `subagent::session`, which take 7 parameters each.
- **`main` exits 0 when the REPL fails.** A stdin or stdout failure inside the REPL returns normally.

### Writes and sessions

- **The approval text is unescaped.** `describe` prints paths, content, and edit text as received. Control characters and carriage
  returns can hide or rewrite what the user approves.
- **Approval and confinement are separate steps.** The description shows the path, and `confine_new` resolves it when the write happens,
  so a symlink changed in between goes unseen. `confine_new` checks ancestors with `Path::exists`, which follows symlinks, so a
  dangling symlink is skipped.
- **Writes are not atomic.** `create_file` creates the file before writing it, and `edit_file` rewrites the file in place. A failure in
  between leaves a partial file. Both should write a temporary file and rename it. `/save` and autosave already do.
- **Session files are not shown as untrusted.** `/load` commits a file's messages as history with no mark that the file came from disk.
- **Autosave files accumulate.** Each run that completes a turn leaves a session file, and nothing removes them.
- **Autosave replaces its own file without checking.** Two runs that start with the same input in the same second overwrite each
  other silently. `/save` refuses a taken name; autosave does not check.
- **Autosave keeps only the latest history.** Each completed turn rewrites the file with the whole history, so compaction and a dropped
  turn remove earlier turns from disk too. The file is a snapshot, not a log.
- **A failed autosave is reported once per turn and nothing else.** The turn stays committed, and the next completed turn writes the
  whole history again.

### Commands and background tasks

- **Commands are not logged.** Every approval, write, and command should be recorded before it runs, with its text, working directory,
  approval, and exit status. `run_powershell` records nothing. Deletion and further execution tools wait for this.
- **The command runs only on Windows.** `run_powershell` starts `powershell.exe` with no platform split. The process handling should move
  behind `tools::process`, with the Windows implementation behind it.
- **Interrupts orphan background tasks.** Ctrl+C ends the process without unwinding, so `WorkspaceTools::drop` does not run and the
  PowerShell processes keep running. The Job Object's kill-on-close flag is the fix; until it is in place the invariant does not hold.
- **Tree kill misses orphans.** `taskkill /T` finds processes by their parent link at stop time. A process whose parent has already
  exited is not found.
- **Background tasks are invisible to the user.** Tool output goes only to the model. Nothing lists tasks, and the user cannot see a
  task's output.
- **Kill approval shows only the id.** `describe` prints "stop background task N". The command and state are not shown.
- **Output is decoded per read.** `Output::since` converts each read's bytes lossily. A character split by a read boundary or by the
  100 KB cap becomes replacement characters.

### Profile hooks

- **Profile files can still be changed by approved shell commands.** An approved `run_powershell` that names `profiles` says a profile may
  change, and can still write a profile file. The model could then add a `hook` line that runs at the next selection, turn, or exit. This
  is the same residual gap as for the command files.
- **Hook lines bypass the profile's tools line.** A profile with `tools: read_file` still runs PowerShell through a hook. This is intended
  for command files, but a profile that narrows the tools is not narrowing what its hooks can do. The user should confirm this decision.
- **Selection can split on an I/O error.** In the `Profile` arm of `repl`, the instructions and tool state change before `select_hooks`
  runs. If that call returns an I/O error, the new profile is selected while the previous profile's hook lines stay active. Hooks and
  instructions should change in one step.
- **Profile errors name no file.** A rejected header line reports only its text, not the profile's name or the line number.
- **Hook output is formatted twice.** `select_hooks` repeats the `Startup command:` block formatting of `startup.rs`.

### Subagents

- **Subagents are invisible.** Their output and status lines go to buffers that are discarded. The user sees only approval prompts, which
  name no subagent or profile. Follow-up failures at the limit are not shown either.
- **Subagent work is unbounded.** A parent turn may start up to `MAX_TOOL_ROUNDS` subagents. Each may run up to `MAX_TOOL_ROUNDS` rounds in
  up to `FOLLOW_UPS` + 1 turns. No total is counted or reported.
- **A failed subagent forgets its writes.** Its conversation is discarded on error, and the parent sees `error: ...` with no changed paths.
  This is the failed-turn gap above, nested.
- **Replies have no size limit.** The final text enters the parent's history unchanged.
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

- **`/model NAME` writes without a prompt on the switch itself.** The switch is checked against the server's list and context size, and
  the save follows it, but neither asks the user first, although `/save` does.
- **`model.txt` is not protected from model writes.** The file tools guard the command files and the profiles folder, not `model.txt`. An
  approved `edit_file` changes the default for the next launch, and the approval text does not say so.
- **The default file is written in place.** `default_model::save` truncates the file before writing. A crash leaves an empty file, which
  `load` reads as no default, so the launch silently uses the built-in model. The save must write a temporary file and rename it.
- **The model cell is borrowed for the whole request.** `complete` and `summarize_messages` pass `&self.model.borrow()` into `send`, so the
  borrow lasts through each `on_event` callback. Nothing re-enters today, but a callback that calls `set_model` would panic.

## Security

Trust boundaries:

- **Model output** is untrusted. It is printed to the terminal and may request tool calls. Tool names and arguments are validated like any
  other input.
- **Tool arguments** are untrusted. A path may be absolute, contain `..`, or name a symlink that leads outside the working directory.
- **Responses from the endpoint** are untrusted input to the parser: malformed JSON, unexpected shapes, and oversized bodies.
- **File and directory names** under the working directory are untrusted text. They can contain instructions to the model.
- **Standing instructions (`AGENTS.md`)** are untrusted text. An approved write can change the file, and the new text then shapes the
  model's behaviour in every later session, since the file is read at each session start and sent with every request.
- **Notes** are text the model writes (after approval) or the user writes. The index and `read_note` results put their text before the model
  in later sessions, so a note is a persistence path for injected instructions.
- **Session files** are JSON histories under `sessions/`. An approved write can create or change one, so the model can write a session the user
  later loads. `/load` commits its messages as history, so a session file is a persistence path for injected instructions and forged tool
  results.
- **Profile files** are untrusted text, and they are command files too. They sit in `profiles/`, which the file tools guard only for direct
  writes, so an approved command can change them. Their text reaches the model verbatim, and their `notes:` line decides which notes the
  model sees. Their `hook` lines run with the user's full permissions and no prompt, and their output goes to the model (except shutdown's).
- **Command files** (`startup.txt`, `before-turn.txt`, `after-turn.txt`, `shutdown.txt`) are untrusted text in the same way as `AGENTS.md`.
  Their lines run with the user's full permissions at every launch, exit, and chat turn, with no prompt. Startup and before-turn output reach
  the model, where a file or page a command reads can carry instructions into later turns. Shutdown output goes nowhere.
- **After-turn output** is untrusted text that can start model turns without a typed line. A failing line's command and output become a user
  message, up to `FOLLOW_UPS` times in a row. Each write those turns request still needs approval.
- **Subagent replies** are model output from a run under another profile's instructions. The parent model reads them as a tool result, so
  they can carry instructions into the parent turn. A subagent's writes reach the parent's approval prompt with nothing naming the subagent.
- **The default model file (`model.txt`)** is untrusted text. An approved write can edit it, and the next launch then switches to the name it
  holds, with no prompt. The name must be one the server lists, so the effect is which model answers.
- **Model ids from `/v1/models`** are untrusted text. `/model` prints them, and they name what each request sends.
- **The API key** lives in `.env` (git-ignored) and in the environment.

What untrusted input can reach:

- Model text reaches the terminal, where escape sequences can rewrite the screen or hide text.
- Read tools expose files under the working directory to the model. Write tools change them, each after the user's approval.
  `run_powershell` executes a command the user approved, with the user's full permissions and no path confinement.
- Tool results and summaries go back to the model. An injected instruction in a file name or in a summary persists through later
  turns, because committed history is resent.
- Error text may echo a server's 400 message or raw body, which must pass through the same sanitization as model text.

Controls:

| Control | Status |
| --- | --- |
| Path confinement for reads and writes | Met. A symlink swapped in after approval is not caught (Open Problems). |
| Write approval, default no | Met. The description is not escaped (Open Problems). |
| Terminal sanitization of streamed model text, approval text, and error text | Missing. Streamed text is printed chunk by chunk, so the filter must work across chunk boundaries. |
| API key never printed, logged, or put in errors | Partly met. Error paths have not been audited. |
| Plain HTTP refused unless the endpoint is loopback | Missing. The endpoint is a loopback constant. |
| Size limits on user lines, profile files, standing instructions, note content, and response bodies | Missing (Open Problems). |
| Size limits on tool output | `read_file` and background task output only. `list_directory` has none. |
| Limits on commands: time, process tree, output | Partly met. A foreground command waits at most 30 seconds, then becomes a background task. Stopping a task ends every process in its Job Object. Output is capped at 100 KB per task. Background tasks have no count limit. Interrupts are not covered (Open Problems). |
| Approval shows what a stop will end | Missing. `kill_background` shows only the id (Open Problems). |
| The user can see what is running | Missing. No listing of background tasks (Open Problems). |
| Tool results, summaries, notes, and hook output marked as untrusted data | Missing. |
| Tools run only when enabled | Met. The grammar constrains the reply and the runner refuses a disabled call. |
| Plain text cannot run a tool | Met. Only the tool call form runs. A prose claim of a tool is committed without running (Open Problems). |
| Arguments checked per tool | Met in `tools::call`, after the grammar. The grammar accepts any object (Open Problems). |
| Enabling a tool | Accepted. `/tools enable` is the user's own action; each write still asks for approval. |
| Profile files limit the notes the model may use | Partly met. The runner refuses a disallowed note before approval, and the index omits it. Earlier index messages and note results stay in history (Open Problems). |
| Profile files set the enabled set | Partly met. A profile's tools line is checked against the catalogue, and selecting a profile is the user's action. Its hook lines run whatever the enabled set is (Open Problems). |
| Profile hook lines run only while their profile is selected | Met. Selecting another profile replaces them at once, and shutdown reads the current ones. A failed selection keeps the old ones. The I/O-error split is open (Open Problems). |
| Profile hook lines run only from a file the model cannot write | Partly met. The file tools refuse the profiles folder, and an approved command that names it says a profile may change. An approved command can still write a profile file (Open Problems). |
| Command-file lines run without approval only from a file the model cannot write | Partly met. The file tools refuse the command files by name, ignoring trailing dots, spaces, and `:` streams, and the profiles folder. An approved command can still write any of them (Open Problems). |
| Command-file and hook lines are not gated by the enabled tool set | Met. They run through `run_command_file_line`, which skips the enabled-set check and keeps the file guard. |
| Command-file, hook, and before-turn and after-turn lines bounded in time, count, and output | Missing (Open Problems). |
| Before-turn lines not run again by a retry | Missing (Open Problems). |
| After-turn follow-ups bounded, and each write approved | Partly met. At most `FOLLOW_UPS` follow-ups per typed line, in a loop. Each write they request still asks for approval. The failure text reaches the model without a typed line (Security). |
| Subagent started only when `run_subagent` is enabled, and never by a subagent | Met. The provider checks the enabled set, the runner refuses a direct call, and `run_subagent` is disabled inside a subagent. The name check in the provider is open (Open Problems). |
| Subagent writes approved with the subagent and profile named | Missing (Open Problems). |
| Bounds on subagents per parent turn, and on their turns | Missing (Open Problems). |
| Subagent output and failures shown to the user | Missing (Open Problems). |
| Subagent profile limits (tools, notes) | Met. They come from the profile and are restored afterwards. Its hooks run without a prompt, as for any profile. |
| Environment disclosure (working directory and standing instructions sent every turn) | Missing. The path and the whole `AGENTS.md` are always sent. The notes index is sent with them. |
| Note names restricted to letters, digits, `-`, `_` | Met. A name cannot leave the notes folder. A symlink named `notes` is still followed (Open Problems). |
| Note writes approved like other writes, including the user's own note commands | Met. `/note create` and `/note delete` go through the runner. |
| Session writes approved like other writes | Met. `/save` asks for approval, and refuses a name that is taken. It does not go through `WorkspaceTools`. |
| Session files checked before they are loaded | Met. `/load` checks each turn before it replaces the history. |
| Session names restricted to letters, digits, `-`, `_` | Met. A name cannot leave the sessions folder. |
| Writes to `AGENTS.md` shown as such | Missing. The approval text reads like any other write, and no warning says the file shapes later sessions. |
| Data exposure (directory listings sent to the endpoint) | Accepted. History reaches disk unredacted through `/save` and autosave, including tool results and command output. |
| Autosave writes without approval | Accepted by design, as the one exception to Write. It writes only `sessions/NAME.json`, and does not check for an existing file of that name (Open Problems). |
| Default model changed only by a successful switch | Partly met. The save follows a successful switch, and the switch itself asks no approval (Open Problems). |
| Default model file protected from model writes | Missing. The file tools do not guard `model.txt` (Open Problems). |
| Model switch checked against the server's list and context size | Met. A name is accepted only when the server lists it with a context size, and the two change together. |
| Model ids from the endpoint sanitized before printing | Missing, as for other model text (terminal sanitization). |

## Future Work

- Per-tool argument rules in the grammar, generated from each `ToolSpec`'s parameters, so the server rejects bad arguments before
  `tools::call` sees them.
- Route each tool's arguments through `tools::call` in tests, so the path from raw arguments to `Invocation` is tested as one unit.
- Make `ToolSpec`, `bind`, and each `SPEC` visible only inside `tools`.
- Sanitization of streamed text per chunk (see Security).
- One output cap and one background-task count limit, shared by all command files and hooks.
- One settings file for the endpoint, the default model, and the budgets, read once by `main` and passed down, so `default_model` is not
  a separate source.
- Configuration from a file or environment, with overrides for endpoint, timeouts, and the history and compaction budgets.
- A `/compact` report that shows the summary and how many turns and tokens it replaced.
- Token-aware trimming of old turns, as the fallback when a summary does not fit, in place of dropping the oldest turn outright.
- A `/jobs` command that lists background tasks with their command, state, and age, and a way to read a task's output from the terminal.
- Deletion and further execution tools, only after logging is implemented.
- A `/note edit NAME` form that changes a note's content through the runner's approval.
- A `/profile` form that clears the selection, and a listing that shows the selected profile. Clearing stops its hook lines too.
- Subagent output shown to the user in a labelled block, and approval prompts that name the subagent and profile that asked for a write.
- One command-file policy table: for each file, when it runs, where its output goes, what counts as failure, and its line and output limits.
  Startup, before-turn, after-turn, and shutdown would then differ only by that table, and profile hooks would use one entry per hook kind.

## Performance

Obvious concerns only; profile before optimizing.

- Each turn sends the whole conversation, and each tool round in a turn resends it. Cost grows with history length.
- Compaction is a full generation over the conversation. It runs only at the budget.
- The REPL blocks on each request, and input typed during a long generation waits in the terminal.
- Thinking runs before any answer text appears, and a long thinking block (up to the 8192-token reply cap) shows only a counter until the
  answer starts.
- A directory listing walks the tree synchronously with no entry cap.
- A foreground command blocks the REPL for up to its 30-second wait. Background tasks have no count limit, and each keeps up to 100 KB of
  output, so many long-running tasks use memory in proportion.
- Each request builds a new `ureq` request. One shared agent would reuse connections.
- `/save` and `/load` encode and decode the whole history as pretty-printed JSON in one string, and `/load` reads all of it before the turn check.
- Before-turn lines run before every chat turn, so each turn waits for their sum before its request, and their output is resent with every later
  request. A selected profile's before-turn and after-turn hooks add to these waits.
- After-turn lines run after every chat turn, and a failing line can cause up to `FOLLOW_UPS` more turns, each with its own before-turn run and request.
- The standing instructions are resent with every request, so a large `AGENTS.md` adds prompt tokens to every turn and every tool round.
- Startup and shutdown run their lines one after another, each up to its 30-second wait. A file with several slow lines delays the REPL, or the
  exit, by their sum.
- The notes index is resent whenever notes change, one line per note. Building it reads every note in full (Open Problems), on each user message
  that checks it.
- Each subagent gathers its environment (reading `AGENTS.md`) and sends its own context, so each start costs a full first request before any tool
  work. Its turns repeat the parent's before-turn and after-turn waits.
- Grammar-constrained decoding checks each token against the grammar. Measure its cost against an unconstrained request before adding per-tool
  argument rules.
