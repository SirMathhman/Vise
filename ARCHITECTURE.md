# Vise Architecture

Vise is a terminal chat client for a local llama.cpp server with an OpenAI-compatible
`/v1/chat/completions` endpoint. The model can read and write files under the working directory
through tools, and runs PowerShell commands; the user approves every write.

This document holds the cross-cutting design: the shared vocabulary, the security model, and the
open-ended work and performance notes. Crate-specific structure, invariants, rules, dependencies,
and open problems live in each crate's own document. It is a reference, not a changelog: finished
work is removed, not annotated.

## Crate documentation

- [vise-core](crates/vise-core/ARCHITECTURE.md) — the backend library: engine, session, provider, tools,
  saved sessions, profiles, notes, command files, and the frontend boundary.
- [vise-cli](crates/vise-cli/ARCHITECTURE.md) — the terminal frontend: REPL loop, rendering, colors,
  and Ctrl+C handling.
- [vise-gui](crates/vise-gui/ARCHITECTURE.md) — the window frontend: egui on wgpu, worker thread,
  transcript, and approval dialog.

## Definitions

The shared vocabulary. Terms that are specific to one crate are defined in that crate's document.

- **Turn**: one user line, the tool exchanges the model makes while answering it, and the final assistant
  reply. A turn is committed whole or not at all. A follow-up turn is a turn of its own, whose user message
  is the failure text of the after-turn commands.
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
  `update_note`, `delete_note`, and `run_subagent`. A write the model asks for runs only after the user approves it. The
  user's typed commands `/note create CATEGORY NAME`, `/note delete NAME`, `/save`, and `/model NAME` do not prompt, because
  typing the command is the consent. Exceptions are autosave and the command lines. A declined write is reported to the
  model as an error and changes nothing.
- **Note**: a named file, `notes/NAME.md`, starting with a `---` header of one `summary:` line and one `category:`
  line (and any other header lines, which a profile uses), then the content. Notes persist across sessions.
- **Notes index**: the list of every allowed note's name, category, and summary, or `[Notes]` followed by `(none)`.
- **Session**: the history after the system context, saved by `/save` as a row in the sessions folder's database
  (`sessions/sessions.db`) and loaded into the run by `/load`, which leaves the stored row unchanged. At launch the run
  resumes the session with the latest `saved_at` that holds messages, and autosave goes on writing to it. `/new` and a
  `--new` flag start an empty session instead; autosave then names it from the run's first input and the time. After
  `/load` the loaded history gets a new autosave session.
- **Request log**: the `requests` rows of one session, one per request the session's turns made, kept for auditing what a
  prompt cost. It is not part of the history: it outlives the turns it was made for, and it is never rewritten. It belongs
  to the session that was writing when each request was sent.
- **Profile**: a note with the category `profile` (`notes/NAME.md`), selected with `/profile NAME`. The note's content, under a
  heading that names it, is prepended to the next user message only. Its optional extra header lines, in any order, are
  `tools:` (the tools it allows), `notes:` (the notes the model may use), and `hook KIND: COMMAND`; any other extra line
  makes the profile fail to load. The profile `default` is built in: it needs no note, has no instructions, no header lines
  (so every tool and note is allowed), and no hooks. It is always listed, and selecting it is the way to return to an
  unrestricted state. A note named `default` is shadowed by it.
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
  thinking-token count, a piece of answer text, a tool call about to run, or the end of the request.
- **Wire type**: a struct matching the JSON shape of a provider request or response. Wire types never leave
  `provider::llama_cpp`.

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
- **Stored sessions** are rows of `sessions/sessions.db`. An approved write can change the database file, and a `sessions/NAME.json` file
  left for import is read at launch, so the model can write a session the user later loads. `/load` commits its messages as history, so a
  stored session is a persistence path for injected instructions and forged tool results.
- **Profile notes** are untrusted text, and they are command files too. They sit in `notes/` with the category `profile`, which the file tools and an approved command may write after approval, so the
  model can author them; a subagent runs a profile whose hook lines the user has not confirmed without them. Their text reaches the model verbatim, and their `notes:` line decides which notes the
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
  `run_powershell` executes a command the user approved, with the user's full permissions.
- Tool results and summaries go back to the model. An injected instruction in a file name or in a summary persists through later
  turns, because committed history is resent.
- Error text may echo a server's 400 message or raw body, which must pass through the same sanitization as model text.

Controls: the per-control status (path confinement, write approval, terminal sanitization, size limits, command limits,
profile and subagent gating, session and model handling) is tracked against the gaps in the crate documents' Open
Problems sections. The standing summary: most controls are met or accepted by design; the recurring gaps are terminal
sanitization of streamed text, size limits on user content and tool output, command and hook bounds, subagent visibility,
and the protection of `model.txt` and the command files from model writes.

## Future Work

- Value rules in the grammar, generated from each `ToolSpec`'s parameter types and ranges, so the server rejects a wrong type or a
  value out of range before `tools::call` sees it.
- Route each tool's arguments through `tools::call` in tests, so the path from raw arguments to `Invocation` is tested as one unit.
- Make `ToolSpec`, `bind`, and each `SPEC` visible only inside `tools`.
- Sanitization of streamed text per chunk (see Security).
- One output cap and one background-task count limit, shared by all command files and hooks.
- One settings file for the endpoint, the default model, and the budgets, read once by `main` and passed down, so `default_model` is not
  a separate source.
- A second frontend (a GUI or a local web page) driven by the same `Engine` on a worker thread: serializable `Request` and
  `UiEvent`, typed query results, approvals as pending events with an id and an origin, and an engine that owns its parts (see The
  frontend boundary). A conformance test that drives a scripted `Frontend` through every `Request` would keep the two honest.
- A `SessionStore` value built by `main` and passed to `repl` in place of the folder path, so the schema runs once per run rather
  than per open, and the store's tests are hermetic.
- Configuration from a file or environment, with overrides for endpoint, timeouts, and the history and compaction budgets.
- A `/compact` report that shows the summary and how many turns and tokens it replaced.
- Token-aware trimming of old turns, as the fallback when a summary does not fit, in place of dropping the oldest turn outright.
- A `/jobs` command that lists background tasks with their command, state, and age, and a way to read a task's output from the terminal.
- A `/timings` command that reads the current session's request rows back through the store and prints them as a table, with a
  per-turn total of prompt and generated time, so the audit does not need an external SQLite client.
- One audit log for the working directory rather than one per session: request rows, approvals, write commands with their text and
  exit status, all keyed on the session name and the time, so removing a session does not remove the record of what it cost.
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
- `/save` and `/load` read and write the whole history one row per message to `sessions/sessions.db`, and `/load` reads all of it before
  the turn check. Each command opens and closes its own connection, and the schema is re-run per open. `/save` opens two: `save`
  looks the name up through `check_save`, then `write` opens the connection it writes on.
- Every autosave appends whatever part of the request log it has not yet stored, and finds that part by counting the rows already
  written for the session, so the comparison repeats on every turn. The log is one row per request, which is one row per tool round.
  The count belongs on the `sessions` row, where an append reads one integer instead of counting a table, and the same integer answers
  "which session did these rows belong to?".
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
- Grammar-constrained decoding checks each token against the grammar. Measure its cost against an unconstrained request before adding
  value rules to the per-tool argument rules.
