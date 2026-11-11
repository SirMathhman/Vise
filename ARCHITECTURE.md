# Architecture

This is the canonical design document for Vise. It describes the architecture the project is working toward, not the current code. Keep it ahead of the implementation: when the code catches up, advance this document. It is not a changelog; completed work lives in the git log.

Vise is a Bun + TypeScript command-line application. The target shape is a small, pure core that interprets lines of input, with a thin terminal frontend that owns all I/O.

Requirements are split into two classes. **Functional** requirements say what the system must do or report. **Nonfunctional** requirements say how well it must do it: security, performance, reliability, maintainability, portability, testability, and cost.

## Definitions

| Term | Meaning |
| --- | --- |
| **Approval** | The user's yes, typed after a preview, before a tool that writes or runs a command. |
| **Command** | A line whose trimmed text starts with `/`. Commands are interpreted by the core and never sent to the model (see Behaviour: Commands). |
| **Compaction** | Replacing the history with a summary of it. |
| **Composition root** | The single entry point (`index.ts`) that wires a frontend to the core and reads the process environment. It is the only place that touches `process`. |
| **Core** | The pure logic that turns an input line into a result: line classification, command interpretation, and conversation state and compaction. Core code takes data in and returns data out. It never reads stdin, writes stdout, reads the environment, or touches the clock or filesystem without being passed the capability. |
| **Frontend** | Code that connects the core to a medium. The terminal frontend is the only one today. It owns readline, prompts, and stream handling. |
| **Hook** | A command in `.vise/hooks.json` that runs at one of four points: `sessionStart`, `sessionEnd`, `turnStart`, `turnEnd`. |
| **Instructions** | The text of `AGENTS.md` in the working directory, read once when the session starts. |
| **Line** | One unit of input without its terminator. Lines are processed in order, and each is handled at most once. |
| **Note** | A Markdown file at `notes/<category>/<name>.md` under the working directory (see Behaviour: Notes and profiles). |
| **Open file** | A file whose path the session keeps as open in the page's viewer. The session keeps the paths only; the page holds the text and reads it again after a reload. |
| **Profile** | A note in the `profile` category whose text is custom instructions for the model. |
| **Provider** | The model service the session uses, behind the `Provider` contract in `src/core/messages.ts`: a default model, a reply stream, the context window of a model, and the list of models. The composition root builds one provider from the environment and the servers in `.vise/providers.json`, and passes only that. The adapters are OpenRouter and each llama.cpp server. A router sends a model named `<server>::<id>` to its server, under `<id>`, and every other model to OpenRouter. |
| **Saved session** | A conversation written to `.vise/sessions/<name>.json` by `/save` and by autosave, and read back by `/load`. It holds the history, the active and pending profile, the pending hook output, the switched-off tools, the last prompt size, the compacted flag, and the name of the session it autosaves to. `/load` replaces the current conversation with it. The file is data from outside the run (see Security). |
| **Session** | One run of the REPL, from start until `/exit` or end of input. |
| **Subagent** | A conversation of its own, started by the model with `run_subagent`. |
| **Thinking** | The model's reasoning effort, set by `/thinking`. |
| **Tool** | An action the model may request by name, with arguments it writes as JSON. A tool that writes or runs anything must be approved by the user before it runs. A tool from an MCP server is named `<server>__<tool>` and is always approved. |
| **Tool round** | One request to the model and the tool calls it asked for. |
| **Turn** | One message of the user, with its tool rounds. Each turn has an undo record: the bytes each file had before the turn first changed it. |
| **Undo point** | A turn count `/undo` can return to: 1, 2, 3, 5, 8, and so on, back. |

## Invariants

Each invariant has a label (F1 to F5 for functional, N1 to N6 for nonfunctional). Other sections refer to them by label.

### Functional

#### Lines and the session

- **F1. Exit is final.** Once a session has ended, no line after the exit word produces output or side effects.
- **F2. One response per line.** Every line the frontend accepts produces one response, or none once the session has ended. A message line may produce several parts, in this order: the compaction notice (or its error), then a line for each tool call of each round, then the reply text, and a first message that names an autosave session adds a notice after that. A failed round ends the turn with an error line, and the whole turn is removed from the history.

#### Commands

- **F3. Commands stay out of the model.** A `/` line is consumed by the core whether or not it is known. A command may make the core send the history to the model (`/compact` does), but never its own text.

#### Approval and end of input

- **F4. Approval comes from the user, after the preview.** A write or command the model requests runs only after an approval given after its preview was printed. The one exception is a command the user types (`/note new`, `/tools enable`, `/tools disable`): the user's own line is the decision, and no model text is involved. `/undo` is one of these: it writes files the model changed, with no preview, because the user's own line is the decision. A line received before the preview is never an approval, and a question never leads to a request to the model once input has ended. Approval is enforced where the tool runs, not only by the loop that asks, so a second caller of the tool runner cannot skip it.
- **F5. No work after the end.** Once input has ended or a stream has failed, no further request is sent to the model, whatever the reply has asked for. The turn stops after the reply that was running, and no tool call in it runs once the session has ended.

### Nonfunctional

#### Core and I/O

- **N1. The core does no I/O, and the backend does it only through ports.** Only the frontend reads or writes streams. The backend reaches the network, disk, and processes through the ports the composition root passes in.
- **N2. Deterministic given its input.** Behaviour depends only on the input stream and the arguments passed in, so the same input gives the same output. The exceptions are the model adapter, the context-window lookup, and the compaction summary, whose replies come from the network. Each must return a complete reply or an error, never a silently truncated success. A failed or truncated summary leaves the history unchanged.

#### Streams and exit

- **N3. Streams are released before return.** On every exit path (end of input, `/exit`, a stream error, or a reply that throws), the readline interface is closed and the frontend's error listeners are removed, so the process can end without waiting for more input. MCP server processes and their pipes are released on every exit path, including an interrupt during startup. (Not yet met for that interrupt; see MCP servers under Known Problems.)
- **N4. Late stream errors are reported, not thrown.** A stream error that arrives after a session has returned is reported by the composition root with a readable message and exit code 1. It is never an uncaught exception with a stack trace. (Not yet met; see Known Problems.)

#### Prompt cache and tools

- **N5. The prompt prefix is append-only.** Between compactions the history changes only by appending: a user message, then assistant messages (with any tool calls) and tool messages. Compaction, `/load`, `/new`, and the resume at startup are the only other changes, and each starts a new prefix, so the next request misses the cache once. The undo log is state beside the history, not part of it: `startTurn`, `/undo`, and every recorded change touch the files and the log only, never the messages, so they never change the prefix. A failed request, or a failed round, leaves no trace: the whole turn is removed, so the next request begins with the same messages as the last completed one. The cache breakpoint is a marker on the last message of each request, whatever its role. It never changes which messages are sent.
- **N6. Tool definitions are stable.** The tools are fixed when the session starts: the built-in tools, and the tools of each MCP server in `.vise/mcp.json` that started. Nothing adds or removes a tool while the session runs, and the request carries the same tool definitions every time for as long as the user leaves the switches unchanged. Switches come from `/tools` or from a profile's `tools:` whitelist, and each changes the tools part of the prompt, so the next request misses the cache for the whole prefix. The user accepts that cost. `/tools` switches are saved to `.vise/tools.json` and read at startup. `/load` applies a saved session's switched-off tools for that session only, which is also a change to the tools part.

## Frontend and backend

The session is split into a backend, which owns the turn loop, conversation state, tool rounds, hooks, commands, subagents, and approvals, and a frontend, which owns the terminal. The two talk through a typed event protocol in `src/protocol/`, and only `index.ts` connects them. The terminal frontend is in-process. The browser frontend (`bun run web`, or `index.ts --web`) runs the same session and carries the same messages as JSON over a WebSocket on 127.0.0.1. The protocol is plain data with no functions, so either transport works without changing the backend.

- **Frontend to backend (`ClientMessage`):** `line` (one input line; a browser adds `shown`, the id of the newest approval question its page has displayed), `approval` (an answer to an `approvalRequest`, identified by its `id`), `answer` (the choices picked by position and the user's own line, for an `ask` with the same id), `inputEnded`, and `failed` (a stream error). The browser may send `line`, `approval`, `profileRead` (asks for one profile's detail to edit), `profileWrite` (saves an edited profile), `mcpWrite` (saves the MCP servers the page shows, as a list of entries), `providersWrite` (saves the llama.cpp servers the page shows, each with its name, URL, and key; a blank key keeps the key saved under that name), and `folderChange` (moves the session to another folder), `pickFolder` (opens the folder dialog on the machine running Vise; a folder picked is switched to at once), `treeRead` (asks for the entries of one folder of the file tree, by a path relative to the working directory), `fileRead` (asks for the whole text of one file, by a path relative to the working directory), and `fileClose` (drops one file from the set of open files the session keeps; the text is not sent). Its server parses every other kind as an error, so a closed tab never ends the session.
- **Backend to frontend (`ServerEvent`):** `text` (a reply chunk, raw and unsanitized), `replyEnd`, `thinking` and `thinkingDone`, `toolCall` and `toolSkipped`, `approvalRequest` (with `id` and `preview`), `approvalAnswered` (with `id` and `answer`, so a reconnecting frontend knows which questions are still open), `ask` (a question the model asked, with its `choices`) and `askAnswered` (the answer in the words the model is given), `history` (the messages of the conversation the session has now, at the start, after `/new`, and after `/load`), `sessions` (the named sessions `/load` can load, at the start and after each `/save`), `tools` (every tool and whether it is on, at the start and after each command that returns a new conversation, such as `/tools`, `/profile`, `/load`, `/new`, and `/compact`), `profiles` (the profiles the page can edit, at the start and after each save), `profile` (one profile's detail, answering a `profileRead`), `folder` (the folder the session works in, at the start of each session), `tree` (the entries of one folder of the file tree: the top folder at the start of each session, and each folder the page asks for), `file` (the whole text of one file, answering a `fileRead`, sent to the page that asked only), `openFiles` (the paths of the files the session has open, after each open or close; the text is never sent here), `mcp` (the MCP servers as they went at the start, `running`, and as `.vise/mcp.json` configures them, `servers`; at the start and after each save), `providers` (the llama.cpp servers, with name, URL, and whether a key is saved, never the key; at the start and after each save), `hookOutput` (the full text), `notice`, `error`, `ready`, and `ended`. The event stream ends after `ended`.

Decisions that keep F4 and F5 true across the split:

- **Approval (F4).** The backend's `approve` drops the lines queued before the question, emits `approvalRequest`, and waits. The answer is the next line the backend receives, read by `answerOfLine` in `src/core/commands.ts`, or an `approval` message with the question's `id`. A browser line carries `shown`; while a question is open, a line whose `shown` is not that question's id is not an answer. The backend drops it and sends a notice, because the user typed it before seeing the question. A line without `shown` (the terminal) is read as the answer, as before. A frontend keeps no approval state of its own: the browser page derives the open question from the events it has received (the last `approvalRequest` with no `approvalAnswered`), and uses it only to lock its controls: the composer, the header's New conversation button, and the panels' switches and saves, which share one rule (`canSend`). Enforcement stays in `runTool`.
- **No work after the end (F5).** The backend owns the inbox of lines. `finished()` is `exitRequested || streamError || !inbox.more`, so queued lines still count as input.
- **Presentation is the frontend's.** Sanitizing, the thinking line's redraw, the 4000-character display cap on hook output, and prompts are done by the frontend's renderer. The backend never writes escape sequences.
- **Command handlers** emit `notice` and `error` events and do not take a stream.
- **Browser storage.** The page may keep in `localStorage` only per-viewer preferences: the theme under `vise.theme` and the column widths under `vise.columnWidths`. It keeps no conversation text, file contents, file names, tokens, approvals, or MCP configuration there, since a shared or left-open browser would expose them. Every value read back is untrusted: it is checked for type and clamped to the same minimums and room as a drag, so a bad stored value cannot break the layout. Every read and write is wrapped in try/catch, and the page renders correctly without storage.

The dependency rules are in Dependency direction below.

## Behaviour

### Commands

The commands are `/exit`, `/context`, `/compact`, `/note`, `/profile`, `/tools`, `/mcp`, `/undo`, `/thinking`, `/model`, `/save`, `/load`, `/sessions`, `/new`, and `/help`. The core classifies any other `/` line as `unknown-command`, and the frontend reports it as an error.

- **`/exit`**: the core recognises a line whose trimmed text is `/exit`. After it, the session accepts no further lines, even ones that arrived in the same chunk of input. Bare words such as `exit` or `quit` are ordinary lines.
- **`/context`**: reports the prompt tokens the provider counted for the most recent request that reported usage, out of the model's context window. Both numbers come from the provider, not an estimate. Before any request has reported usage, it says no request has been sent. After a compaction, it says the size is unknown until the next request, because the counted size described the history that was replaced. It never says no request was sent when one was.
- **`/compact`**: runs a compaction now (see Compaction).
- **`/note new <category> <name>`** creates a note with its scaffold. **`/note list [category]`** lists notes. The core reads the words, and a note runner that the composition root passes in does the file work. A `/note` line never reaches the model.
- **`/profile`**: see Notes and profiles.
- **The page's tools panel** shows each tool as a button, on or off, from the switches alone. Clicking one sends `/tools enable <tool>` or `/tools disable <tool>` as a line, as typing it would, so the browser still sends only lines and approvals. The buttons are disabled while an approval is open or the page cannot send, as the composer is. The panel does not show a profile's `tools:` whitelist (see Known Problems).
- **`/tools`** lists the tools and whether each is on. **`/tools enable|disable <tool>`** switches one. The switch applies from the next request and is saved to `.vise/tools.json`. A switched-off tool is left out of the request, and a call to it is refused without approval.
- **`/undo [turns back]`**: puts the files back to where they were at the start of the turn that is the given number of turns back (1 when none is given). Only the points are accepted. A revert refuses, and changes nothing, when a file it would restore no longer holds what Vise last wrote to it. It changes no message, so the prompt cache is unaffected. The log is in memory, and it covers `edit_file`, `create_file`, and `create_note` only (see Known Problems).
- **`/thinking off|low|medium|high`**: sets the thinking effort (see Thinking).
- **`/model`** shows the model in use. **`/model search <text>`** lists the models whose id contains the text, ignoring case, in alphabetical order. **`/model <name>`** switches to a listed model and keeps the conversation. The choice is saved to `.vise/model.json`.
- **`/help`** prints every command on its own line, with its usage and a one-line summary. **`/help <command>`** prints the usage and a fuller description of that command. The text is built in `src/core/commands.ts` from one table, and the backend emits it as a notice. An unknown name is an error. Like every command, it never reaches the model.
- **The page's sessions panel** lists the names from the last `sessions` event. Clicking one sends `/load <name>` as a line, the same as typing it, so the browser still sends only lines and approvals. The terminal does not show the panel.
- **`/save <name>`** writes the conversation as a saved session, replacing one of the same name. **`/load <name>`** replaces the conversation with a saved session and applies that session's switched-off tools, for that session only; it does not write `.vise/tools.json`. **`/sessions`** lists the saved names.

### Notes and profiles

- A **note** is a Markdown file at `notes/<category>/<name>.md`. The name and category come from the path, and each may contain only letters, digits, `-`, and `_`. The file starts with a header of `name`, `category`, and `summary` lines between two `---` lines, then the body. Creating a note writes that scaffold and refuses an existing file. Reading and editing notes is done with the file tools, not by Vise.
- **`/mcp`** prints each MCP server as it went at the start of this session: whether it started, its tools, and each problem that left a server or a tool out. It takes no words, and it changes nothing. A change to `.vise/mcp.json` applies at the next start.
- **The page's folder bar.** It shows the folder the session works in, with a box for another folder, a Switch button, which sends `folderChange`, and a Pick folder button, which sends `pickFolder`. The dialog is a Windows folder dialog opened through PowerShell on the machine running Vise (`src/tools/process/folder-picker.ts`), so the page must be on that machine. A cancelled dialog changes nothing. Opening the dialog is the user's own click, so it needs no approval. The web server ends the current session, waiting for its current turn to finish, then starts a new session in the folder. The process moves there with `process.chdir`, and the folder's instructions, hooks, MCP servers, tool settings, and undo log are read again. The conversation starts empty, and the model choice is kept. Any folder that exists can be chosen, and the folder's hooks and MCP servers start with no consent step, as they would on a start there. A folder that cannot be read from ends the session with the error.
- **The page's layout.** The page is one workspace below the header and folder bar. While no file is open, the workspace is a single column: the Files tree, then the panels, transcript, and composer, in page flow. While a file is open on a window at least 960px wide, the page fills the window height and has three columns: the Files tree, the file's text, and the chat (the panels, the transcript, and the composer). Each column fills the height, and the composer stays at the bottom of the chat column. The Files tree, the file's text, and the transcript each scroll, and the chat's panels form one group with a height cap. A narrower window stacks the columns, tree first, with the page flow. The class `split-view` on the app is the only switch; the columns are built by `columns()` (`src/web/client/layout/columns.ts`), and their CSS is at the end of `style.css`.
- **The page's file tree.** A Files panel shows the working directory's entries as folders that open in place. The top folder is sent at the start of each session; a folder's entries are read when the user first opens it, and kept until the folder changes. Hidden entries and links are skipped, as `list_files` skips them. A listing of a folder that cannot be read is reported as an error event. A click on a file sends `fileRead`, and the page shows the answer as a tab in a read-only viewer beside the tree. A `.md` file opens rendered as Markdown, with a Source button that shows its raw text and a Rendered button that goes back; that choice is kept in the page's memory for the file, never stored or sent. Several files may be open, one tab each. The session keeps the set of open paths, never the text, and sends it as `openFiles` after each change. A tab's Close button sends `fileClose`. The set is cleared by a folder change and is not kept across a restart of Vise. After a reload, the page reads the text of each open path again with `fileRead`, and a path whose read fails must leave the set (see Known Problems). A file over 1 MB, a folder, and a binary file (one with a NUL byte) are refused with an error event. The viewer's text goes to the page only and never to the model.
- **The page's header.** It holds the connection status, the theme select (System, Light, or Dark: `themeControl` in `src/web/client/theme/theme.ts`), the Undo button, and the New conversation button. The header wraps its controls onto a further line when the window is narrow, so no control is clipped and the page never scrolls sideways.
- **The page's New conversation button.** It sits in the header and sends `/new` as a line, as typing it would. It is disabled while the page cannot send, or an approval or ask question is open. Without a confirmation, since the conversation stays in its autosaved session and `/load` can bring it back.
- **The page's MCP section.** The page shows each configured server with its state at the start (started, did not start, or added since the start), and its problems. The tools of the servers are switched in the page's tools panel, as the other tools are. Edit servers opens a dialog with a row per server (name, command, and one argument per line). Save sends `mcpWrite` with every row, and the store writes the file only when every entry passes the checks that a read makes. Saving is the user's confirmation, so the file is written without a further question, and a saved server starts at the next start. A change applies at the next start, not at once.
- **The page's Providers panel.** The panel lists each llama.cpp server by name and URL, and never by key: it says only whether a key is saved. Edit providers opens a dialog with a row per server (name, URL, and a key field that is blank when a key is saved). Save sends `providersWrite` with every row, and the store writes `.vise/providers.json` only when every entry passes the checks a read makes (a name with no colon and unique, a URL, and a key for a new server). A blank key keeps the key saved under the same name, so a renamed server needs its key again. A server left out of the save is removed. Saving is the user's confirmation, and a change applies at the next start, as the MCP servers do.
- **The page's profile editor.** The page lists the profiles, and clicking one sends `profileRead` and opens its detail in a dialog: the summary, which tools it allows (every tool checked means no whitelist), its hooks, and its text. Save sends `profileWrite`, and is disabled while an approval is open or the page cannot send. The backend writes the file only for a profile that already exists, after it checks the detail: a name that is one file name, a summary and each hook command on one line, a hook point that exists, a tool that exists, and text that is not empty. The page cannot create a profile; `/note new profile <name>` does. A hook saved from the page runs at its point without approval, the same as a hook written in the file.
- A **profile** is a note in the `profile` category. Its text below the header is custom instructions for the model. Its header may add hooks as `<point>: <command>` lines (for example `turnEnd: npm test`). While the profile is active, its commands for a point run after the global hooks of that point, without approval, and apply from the next point after a switch. A profile's commands can come from any repository that ships the profile, so a profile is as trusted as `.vise/hooks.json`.
- A profile's header may have a `tools:` line, a comma-separated whitelist of the tools the profile allows. A tool is offered only if `/tools` allows it and the list includes it. A name that is not a tool refuses the profile. A profile with no `tools:` line narrows nothing.
- `/profile <name>` makes a profile active. Its text is recorded as pending and sent once, in front of the next user message, as user text rather than a system message. The history already sent is never rewritten, so the switch appends to the history and the prompt cache stays valid. `/profile` alone shows the active profile, and `/profile default` turns profiles off.
- A profile is sent after AGENTS.md (see Instructions). Compaction drops its text from the history, so the active profile is sent again with the next message. A switch does not remove an earlier profile's text from the history (see Known Problems).

### Turns and tool rounds

- A message runs tool rounds until the model answers without a tool call. Each call of a round is shown as a line, run, and its result appended to the history as a tool message before the next round. The loop has no round limit, by the user's choice, so a model that keeps calling tools keeps the session busy.
- Each tool is defined in `src/core/tools.ts` (its spec, its argument parsing, its approval rule, and the line shown for a call). A `ToolRunner` that the composition root passes in runs it. Apart from `run_powershell`, which passes the model's command to PowerShell, a tool never receives the model's text as code.
- The tools are:
  - read only: `list_files`, `read_file`, `read_command`;
  - writes, approved by the user: `edit_file` (replaces the first exact match of a text in an existing file), `create_file` (writes a new file and never overwrites one), `create_note` (creates a note's scaffold at its convention path and never overwrites one);
  - commands: `run_powershell` (one PowerShell command in the working directory; a command still running after 30 seconds becomes a background job), `read_command` (reads a job's output), and `kill_command` (stops a job, approved by the user);
  - `run_subagent` (starts a subagent; see Subagents);
  - `ask_user` (asks the user a question with at least one choice, and returns the answer; see Asking the user);
  - MCP tools, named `<server>__<tool>`, from the servers in `.vise/mcp.json` (see MCP servers).
- Of the ten built-in tools, eight run in `src/tools/` through `runTool`, which dispatches by name and checks the target before asking. `run_subagent` and `ask_user` are started by the backend, not by `runTool`, because it runs a conversation rather than a single action. Whichever part runs a call, the call is first checked against the tools offered in this request, by one shared check, so a switched-off tool is refused the same way for every tool (see Future Work).

### Approval

**Asking the user.** `ask_user` takes a question and at least one choice. The question and its choices are shown, and the answer is either the numbers of the choices picked (one line of numbers separated by commas or spaces, or a card's checkboxes), or a line of the user's own. Both may be given on the page. The model receives the answer as the tool result, as `the user chose: ...`, `the user answered: ...`, or `the user gave no answer`. A question uses the same open-question slot as an approval: the lines queued before it are dropped, a page answer must carry its id, and input ending while it is open closes it with no answer. It is not an approval and is not refused by the page's save lock. It is not offered to a subagent, so a subagent's question never reaches the user without the context of the main conversation.

The approval question shows the change or command, and the answer is a line the user types after that preview has been printed. Any other answer is a refusal, and so are end of input and a stream error. A refusal is returned to the model as the tool's result, and the turn goes on. End of input, a stream error, or `/exit` during a question ends the session and sends no further request to the model.

### Thinking

`/thinking` sets the reasoning effort for the next request, sent as the request's `reasoning` effort. It is off by default.

- While the model thinks, one line shows an approximate count of thinking tokens. The estimate is four characters to a token, from the reasoning text in the stream (`delta.reasoning_details` and `delta.reasoning`).
- When the reply ends, the line shows the exact count from the usage report (`completion_tokens_details.reasoning_tokens`), or the estimate when the provider gives none.
- The count is never the thinking text. Reasoning items with no text, such as encrypted ones, add nothing to the estimate.
- The reasoning shape is based on OpenRouter's documentation and has not been checked against the service.
- The reasoning items of an assistant message that made tool calls are kept with that message, exactly as the provider sent them, and sent back in every later request. The provider needs them to continue a tool round while thinking is on (see Known Problems).
- Subagents do not think.

### Compaction

Compaction replaces the history with a summary. It requests the summary by sending the whole history followed by a fixed request. The new history is the summary, kept as a user message, followed by the most recent six messages. Compaction runs on `/compact`, and automatically before a message when the last prompt tokens reached 80% of the context window. The rules live in `src/core/compaction.ts`. Building the request and the new history, and the 80% check, are pure. `compact` asks for the summary through the `Reply` port, which is its only I/O. The summary is model output, so it is untrusted text (see Security).

### Hooks

A hook is a command in `.vise/hooks.json`. A point may list several commands, which run in order. Hooks run without approval, because the file is trusted. A hook's output is kept in `pendingOutput` and goes in front of the next user message, so the history keeps alternating and nothing already sent is rewritten. The output is also printed to the terminal, sanitized and capped, at the point it is produced, so the user sees what the model will see.

- A failing `turnStart` hook stops that turn before it begins.
- A failing `turnEnd` hook stops the session.
- A failing `sessionStart` hook refuses the session.
- A failing `sessionEnd` hook is reported.
- A command counts as failed when it exits non-zero or is still running after the timeout.

Hooks run in `src/tools/hooks/hooks.ts`. The turn itself runs in `runMessageTurn` in `src/repl/repl.ts`.

### Instructions

The text of `AGENTS.md` in the working directory is read once when the session starts. Each request of a turn puts it in front of the first message it sends (`withInstructions` in `src/core/messages.ts`, called by `runMessageTurn` in `src/backend/turn.ts`), so it is the first thing the model sees, and compaction cannot drop it. It is kept in the first user message, as sent, by design. The stored history does not hold it: the history keeps only what the user wrote, so a resumed or loaded conversation uses the file as it is at that start, not the text it was saved with. The compaction request and the subagent requests do not carry it (see Known Problems). A missing or blank file gives no instructions and no message. The composition root reads the file in `src/instructions.ts`, and the backend receives only the text. The path and size are not shown to the user before the text is sent (see Security). Saved sessions and the resume file from before this change still hold a copy in their first message (see Known Problems).

### Subagents

A subagent is started by the model with `run_subagent`, which takes a profile name, a task, and a `max_tool_calls` limit.

- It runs the turn-start hooks, then its profile's text and the task as its first message, then its own tool rounds.
- It is offered only the tools its profile lists, minus the tools the user has switched off with `/tools`. It is never offered `run_subagent` or `ask_user` itself. A profile with no `tools:` line refuses a subagent.
- It makes at most `max_tool_calls` tool calls. At the limit it is asked once more with no tools, and its answer is marked as cut short.
- Its writes and commands ask the user through the same approval queue as the main conversation, one question at a time.
- Several subagents asked for in one reply run together, and the calls of that reply wait for them.
- Only its final answer returns to the main conversation, as the tool result. Its history is not kept, saved, or added to the main history.
- It runs the turn-end hooks, and the global and profile hooks, in the same order as a turn.
- Its loop is started by the backend (`src/backend/subagent/subagent.ts`), not by `runTool`. It is a second tool-round loop beside the turn (see Known Problems).

### Saved sessions

A saved session holds the fields listed under Definitions. `/load` puts its history into the next request with the user's authority, so the file is checked before it is applied (see Security and Known Problems).

**Autosave.** The first message of a conversation names a saved session: its words in lower case joined by hyphens, up to 40 characters (`autosaveName`), or `autosave` when it has no letters or digits. A name already taken gets `-2`, `-3`, and so on, so a saved session is not overwritten (the gaps are under Known Problems). The name is kept in the conversation (`autosave`), so it survives a restart. After each line, the conversation is written to that session as well as to the resume file. `/new` clears the name, so the next first message names a new session; `/load` makes the loaded session the one autosaved from then on. The terminal and the page both show the name in a notice, and the page's sessions panel lists it. A failure to list the names means no autosave for that message.

**Resume.** After every line that the session processes, the conversation is written to the resume file, in the same format as `/save`. The file is kept in the user's home folder under `.vise/resume/`, named by a hash of the working directory, so it is outside the project and a repository cannot ship one. At start, the session loads it: the earlier messages are sent as a `history` event (the terminal prints them, the page shows them), and the model gets the history. The switched-off tools come from the settings file, not from the resume file. The profile is not restored: only the history, the compacted flag, and the prompt size come back, so the profile's hooks do not run at start and its text is not sent again. The profile must be chosen again with `/profile`. `/new` starts with no history and saves that. A file that cannot be read is reported, and the session starts with no history. The write is not atomic, so a crash mid-write leaves a file that is refused at the next start. Two sessions in the same directory share one file, and the last to save wins. Known gap: the page drops the "resumed" notice because the `history` event replaces its transcript. The terminal cannot replace what it printed, so after `/new` or `/load` it appends the messages.

## Structure

Target layout. Test files sit beside the module each one tests; there is no separate tests folder.

```
└── vise/
    ├── index.ts                         composition root: wires stdin, stdout, and the provider (built from the environment and `.vise/providers.json`) to the REPL or, with --web, to the browser server; reads the tools and model settings at startup
    ├── scripts/                         build checks run by bun run lint, and the web:dev development script
    │   ├── check-files-per-dir.ts       file count per directory
    │   └── web-dev.ts                   bun run web:dev: runs the browser server and restarts it when a file under src/ or index.ts changes, on the same port and with the same token, so the open page reconnects by itself
    └── src/
        ├── instructions.ts              reads AGENTS.md from the working directory (the one file read at startup)
        ├── providers/                   the model provider behind the Provider contract (core/messages.ts); OpenRouter and each llama.cpp server are the adapters
        │   ├── provider.ts              providerFromEnv: builds the provider from the environment (the OpenRouter key) and from the llama.cpp servers, each a named route
        │   ├── openrouter.ts            OpenRouter adapter: lists models and streams chat through `streamChat`, which takes an endpoint, so llama-cpp.ts reuses it (the shared stream moves to its own module, see Future Work)
        │   ├── llama-cpp.ts             llama.cpp adapter: one provider per server; chat through streamChat, /props and /v1/models with a bearer key; with openrouter.ts and tools/mcp/http-client.ts, one of the modules that open network connections
        │   ├── router.ts                routed: a model named <server>::<id> goes to its server under <id>, any other to the fallback; no network
        │   └── config.ts                readServers, saveServers, and providersStore for .vise/providers.json (name, url, apiKey): read at startup, and written in place from the page (not atomically, see Known Problems). Disk work, so it moves to src/tools with the other settings (see Future Work)
        ├── core/                        pure logic; imports nothing from node: except types
        │   ├── commands.ts              line classification, command parsing, and the /help table (usage and description of each command)
        │   ├── compaction.ts            Conversation state: summary request, compacted history, 80% check, profile use and clear
        │   ├── messages.ts              shared data types, the Provider contract and model ports (ChatMessage, ToolCall, Usage, ReplyRequest, Provider, ProviderRequest, ModelInfo, Reply, ContextWindow), the MCP server entry and status types, McpStore, ProvidersStore (with ProviderEntry, the list without keys, and ProviderInput, the page's rows), and the Result type (ok and err) for returned failures
        │   ├── notes.ts                 note rules: name checks, path and scaffold, header parser, /note and /profile words, NoteRunner and ProfileLoader ports
        │   ├── sessions.ts              saved-session format (encode; decode with shape and pairing checks), autosave naming (autosaveName, uniqueName), /save, /load, /sessions words, SessionStore port
        │   ├── tools.ts                 tool specs, argument parsing, /tools words, the name rule for MCP tools (isExternalName), Approve and ToolRunner ports
        │   ├── tool-lines.ts            approval rule, approval preview, call line, and the terminal sanitize helper
        │   └── undo/
        │       └── undo-log.ts          the pure undo log: turns, the kept points (1, 2, 3, 5, 8 ...), the revert plan, and the drop of reverted turns (no I/O)
        ├── protocol/                    the frontend-backend contract (types only, plain data)
        │   ├── protocol.ts              ClientMessage, ServerEvent, Session
        │   └── channel.ts               Channel<T>: the async queue the backend's inbox is built on
        ├── backend/                     session engine: no terminal, no readline
        │   ├── session.ts               startSession: session loop, line inbox, approval questions, sessionStart and sessionEnd hooks, autosave choice and writes
        │   ├── turn.ts                  runMessageTurn and streamRound: the turn's tool rounds and hooks
        │   ├── calls.ts                 runCalls: one round's calls, and subagent calls
        │   ├── ports.ts                 SessionPorts: every port the backend uses
        │   ├── file-tree.ts             sends a folder's entries (tree) and a file's text (file) for the page's Files panel
        │   ├── profile-editor.ts        reads and saves a profile for the page, and lists the profiles
        │   ├── mcp-editor.ts            sends the MCP servers (running and configured) and saves the page's edits
        │   ├── providers-editor.ts       sends the llama.cpp servers (names and URLs, never keys) and saves the page's edits through ProvidersStore
        │   ├── subagent/                runSubagent and queueApprovals
        │   └── commands/                command handlers, which emit notices and errors
        ├── repl/                        terminal frontend: readline and rendering
        │   ├── repl.ts                  runRepl: sends lines, prints events, prompts on ready
        │   ├── render.ts                ServerEvent to terminal text: sanitizing, thinking line, hook display cap
        │   └── session-helper.ts        test helper: runWithPorts and echoReply
        ├── web/                         browser frontend: a WebSocket relay and a page in plain TypeScript, with no framework
        │   ├── server/
        │   │   ├── server.ts            startWebServer: listens on 127.0.0.1, checks the token and Origin on the socket, serves the page; the handover runs through handover.ts
        │   │   ├── client-message.ts    reads the browser's messages: lines, approvals, the two profile requests, the MCP save, the providers save, the folder requests, and the tree, file read, and file close messages
        │   │   ├── address.ts           takeWebAddress: reads and removes VISE_WEB_TOKEN and the port at startup
        │   │   ├── page.ts              bundles the page script at startup
        │   │   └── relay/               the session the page talks to, and how it moves between folders
        │   │       ├── hub.ts           keeps every event for replay, except answers to one page's request (file text), which go only to the attached page; one viewer at a time (a new tab takes over the session)
        │   │       └── handover.ts      the folder handover: one phase (running, ending, picking, starting), so input is never dropped; ends the session, starts the next one, and keeps the page
        │   └── client/
        │       ├── main.ts              the socket, reconnects, render schedule (side effects only)
        │       ├── state.ts             pure reducer: server events to the transcript
        │       ├── markdown.ts          pure Markdown subset for replies and viewed .md files (headings, lists, code, bold, italics, inline code; a link keeps its text; no tables or images), no DOM and no imports from the DOM
        │       ├── render/
        │       │   └── markdown-dom.ts   builds the elements for a Markdown subset block list with createElement and textContent only; the one place Markdown becomes DOM, shared by the chat and the viewer
        │       ├── files/
        │       │   ├── tree-view.ts      the file tree; a click on a file sends fileRead
        │       │   └── file-view.ts      the viewer panel: one tab per open file and the text of the shown one (a .md file rendered, with a Source/Rendered button); a tab's Close button sends fileClose, and the panel is hidden while no file is open
        │       ├── layout/
        │       │   ├── columns.ts       the page's body: the tree column, the file column, and the chat column (panels, transcript, composer) in one workspace element; the CSS for the three-column split is at the end of style.css, in a 960px media query
        │       │   └── separators.ts    the two movable separators between the columns: a drag or an arrow key sets a column's width, kept within its minimum; the widths are saved in localStorage (see Browser storage under Decisions)
        │       ├── theme/
│       │   └── theme.ts             the header's theme select: System, Light, or Dark; sets data-theme on the document and keeps the choice in localStorage as vise.theme (see Browser storage under Decisions)
│       ├── mcp-view.ts          the MCP panel and its server editor, built from the state; sends mcpWrite. Also panelBox, the folding panel every list uses (see Known Problems)
│       ├── providers/providers-view.ts  the Providers panel and its editor, built from the state; sends providersWrite, and shows whether a key is saved, never the key
        │       └── view.ts              DOM from the state and from the Markdown blocks, text set with textContent only; sets the split-view class on the app while a file is open
        └── tools/                       disk, process, network, and settings work for the tools and the frontend
            ├── run-tool.ts              dispatches a call by name, checks the target before asking, runs a change only when approve resolves true; MCP calls go to the registry
            ├── mcp/
            │   ├── config.ts            .vise/mcp.json: readMcpConfig (at startup), saveMcpConfig (from the page), mcpStore (the port the session reads through); an entry is a command and args (stdio) or a url and headers (HTTP)
            │   ├── session.ts             McpSession (the request, notify, and stop port both clients implement) and the request time limit
            │   ├── client.ts            one server over stdio: JSON-RPC, one message per line
            │   ├── http-client.ts       one server over HTTP (Streamable HTTP): a POST per message, a JSON or event-stream answer read as it arrives, the session id sent back, and a DELETE on stop
            │   └── registry.ts          starts the servers, lists their tools as <server>__<tool>, runs calls, stops them at exit
            ├── undo/
            │   └── undo-files.ts       records each file change and reverts files to a point, refusing when a file changed outside Vise; the file I/O half of the undo log
            ├── process/                 every spawned process: the child environment, the model's commands, background jobs, and the folder dialog
            │   ├── child-env.ts         childEnvironment: a copy of the environment without the model key and the web token, for every child process
            │   ├── run-powershell.ts    the model's commands; a command still running after 30 seconds becomes a background job
            │   ├── jobs.ts              background jobs: last 500 lines per stream, reads, stops process trees, stops all at exit (at most 5 running)
            │   └── folder-picker.ts     the Windows folder dialog that the page's Pick folder button opens; passed to the server as a port by the composition root, never started by the model
            ├── tool-settings.ts         .vise/tools.json: readToolSettings (at startup) and saveToolSettings (via /tools)
            ├── session-store.ts         .vise/sessions/<name>.json: reads and writes
            ├── resume/
            │   └── resume-store.ts      the resume file in the user's home folder: loads at start, saves after each line
            ├── hooks/
            │   └── hooks.ts             the hooks file (.vise/hooks.json) and the runner for one point's commands
            ├── models/
            │   ├── model-settings.ts    .vise/model.json: readModelSetting (at startup) and saveModelSetting (via /model <name>)
            │   └── select-model.ts      selectModel: refuses unlisted names, saves the choice, then switches the model
            ├── files/                   one runner per file tool; contain.ts (resolveInside, resolveNewInside)
            └── notes/
                ├── create-note.ts       scaffold through createFile
                ├── list-notes.ts        lists note headers
                ├── read-note.ts         reads a note through the containment check
                ├── load-profile.ts      a profile's text and its tools whitelist
                ├── profile-store.ts     lists, reads, and writes existing profiles for the page's editor
                └── run-note-command.ts  the function the REPL calls for a /note line
```

### Dependency direction

```
index.ts  ->  src/repl  ->  src/protocol  ->  src/core (types)
index.ts  ->  src/web/server  ->  src/protocol, src/core
src/web/client  ->  src/protocol (types)
index.ts  ->  src/backend  ->  src/protocol, src/core
index.ts  ->  src/providers  ->  src/core
index.ts  ->  src/tools  ->  src/core
```

`src/core` imports nothing from `src/repl`, `src/backend`, `src/protocol`, `src/tools`, `src/providers`, or `index.ts`. `src/protocol` imports only core types. `src/repl` imports `src/protocol` and core types only, and never `src/backend`, `src/tools`, or `src/providers`. `src/backend` imports `src/protocol` and `src/core`, and reaches disk, processes, and the network only through ports. `src/tools` and `src/providers` may import `src/core`, never the reverse, and they do not import each other. Inside `src/providers`, the adapters (`openrouter.ts`, `llama-cpp.ts`) do not import one another: the chat stream they share lives in a module of its own (today `llama-cpp.ts` imports `streamChat` from `openrouter.ts`, see Future Work), and `router.ts` imports only the adapter types. Reading `.vise/providers.json` is disk work, so it is done in `src/tools`, never in `src/providers`. Only `src/providers/openrouter.ts`, `src/providers/llama-cpp.ts`, and `src/tools/mcp/http-client.ts` open network connections; every other module reaches the network through one of them. Only `index.ts` imports both the frontend and the backend. `src/web/server` follows the rules of `src/repl`, and `src/web/client` may import protocol types only, as type-only imports; it is built for the browser and never runs under Bun. The client is checked with its own tsconfig (`src/web/client/tsconfig.json`), because the browser types are not part of the rest of the project. Tests and the test helper `src/repl/session-helper.ts` may import any module. There are no circular imports.

Recursion is avoided in core. When a function would need to call a function that calls it back, pass the callback as a parameter instead of importing across files.

### Code rules

The size and type rules that `bun run lint` enforces are listed in `AGENTS.md`. The design rule behind them is that each source file has one responsibility. Entry points contain wiring only: they read the environment, construct the functions, and call exported functions.

## Known Problems

Each item is a known defect or gap. Fixes are listed under Future Work.

### Functional

#### Browser page

- **A panel's open state is decided by its first render.** `panelBox` (`src/web/client/mcp-view.ts:234`) sets `open` on the first `show` and never again, so a render before the list arrives decides it. The page starts with empty lists and renders on the first animation frame, so the first show often has a count of 0 and the panel opens for good. Verified in the page: Tools (10) was open, where the panel should start closed above eight items. A panel should decide its state once it has a non-empty list, or leave the decision to the reader after a toggle.
- **The heading is shared by two names.** Each list builder makes a `label` span that `panelBox` drops by class and position (`mcp-view.ts:246`), and the panel title is passed again by the caller (`view.ts:455`, `:461`, `:471`, and `mcp-view.ts` `createMcpSection`). The title is written in three places, and the drop works only while each builder puts its label first.
- **The folding panel lives in a feature module.** `panelBox` is generic, but `mcp-view.ts` is the MCP feature, and `view.ts` imports it from there. The client directory holds ten tracked files, the lint limit, so the helper cannot take a file beside `view.ts` without a subfolder.

- **A folder that fails to list stays at "loading…".** The server answers a `treeRead` that fails with an `error` event, but the page keeps no entry for that folder, so the folder shows "loading…" until it is closed and opened again. The error event does not name the folder, so the page cannot clear the state itself. Missing control: the `tree` event (or a failure event that carries the path) should give the folder an empty or failed state.
- **The file tree has no cap.** A folder's entries go to the page in one `tree` event with no limit on their count, so a folder such as `node_modules` is sent whole, as `list_files` output is (see Cost and size limits).
- **The Markdown DOM builder sits in the parser's module.** `renderMarkdown` and its helpers are in `src/web/client/markdown.ts`, which the Structure section describes as having no DOM. The chat (`view.ts`) and the viewer (`files/file-view.ts`) both use it, and `markdown.test.ts` covers only the parser, so the builder has no test. Missing control: the builder moves to `render/markdown-dom.ts` (see Future Work).
- **The viewer's Source choice outlives its tab.** `file-view.ts` keeps a `.md` path in its `source` set after the tab is closed, so reopening the file shows the source again, and the set is never emptied. Missing control: drop the path when the file leaves the open set.
- **The Source and Rendered button is a small target.** `.file-mode` in `style.css` has 2px vertical padding and 13px text, so it is about 22px tall (estimated from the CSS, not measured), below the 24px floor.
- **The layout's column membership is decided in two places.** `view.ts` decides which elements go in the Files column and which in the chat column (the `columns()` call), and `style.css` decides how the split looks from the `split-view` class and from child selectors such as `.chat > .transcript`, `.chat > .composer`, `.chat .chat-panels`, and `.tree-column > details`. A new panel that is not added to the right array, a new child of `.chat`, or a change to the tree's markup changes the layout without a type or test catching it. `columns.ts` has no test of its own, so nothing checks that the three columns and their classes match the stylesheet. Missing control: give the column classes one shared constant, and a test that renders `columns()` and checks each class is present once.
- **Saved column widths are not checked on read.** `readWidths` (`src/web/client/layout/separators.ts`) accepts any finite number and `applyWidths` sets it without a clamp. A stored `{"tree":5000,"chat":-300}` (verified) makes `grid-template-columns` invalid, so the three columns fall back to one stacked column at 1140px. The separators stay in the page, and dragging one rewrites the value only on pointer-up, so the user cannot recover without clearing storage. Missing control: clamp each stored value to the same minimum and room that `setWidth` uses.
- **The tree's rows are small targets.** Folder and file rows are 25px tall (verified), below the 32px target. A file row reuses the `folder-toggle` class, which names a different control.

#### Input and the session

- **The browser page has no caps.** Hook output is shown in full (the terminal caps it at 4000 characters), a typed line has no length limit, and the hub keeps every event for the life of the session (a folder change resets it) and replays all of them on each connection, so memory and reconnect time grow with the session.
- **Optional ports fail silently.** `fileText?` and `tree?` in `src/backend/ports.ts` are optional. `announceFile` returns with no event when its port is absent, so a click does nothing, while the rule for backend functions is that each answers with an event (see Future Work).
- **Retired exit words reach the model.** `exit` and `quit` are no longer commands, so a user who types them from habit sends them to OpenRouter as a message, which spends a request. The frontend should say which command ends the session.
- **Approval discards queued input silently.** When the preview is printed, the backend's `Channel.discard()` drops every line queued before the question, as F4 requires. The drop is silent. With piped or pasted input, every line arrives at once, so an answer sent with the command is discarded and the command is refused with no message (verified: `a` then `y` piped in one chunk refused the call and dropped `y`).
- **The tool loop continues while queued input remains.** `finished()` stops the loop on a stream error, on `/exit`, or when input has ended and the queue is empty. A queued line keeps the loop going. Input `a` and `b` piped together, with a reply that asks for `list_files`, ran the tool and sent two more requests after the input had ended (verified: three requests in all). Decision: queued lines still count as input to answer, so a piped message followed by `/exit` keeps its tool result. This is accepted, not a defect, but it does not meet F5 as written. A skipped call is answered with a tool message that says it did not run, so every call in the history has a result.

#### Errors and exit

- **Stream errors are reported late.** `runRepl` listens for `error` on input and output, and on the readline interface. It aborts the interface and returns `err`, which `index.ts` prints before exiting with code 1. The abort does not reach the reply, so an error during a model stream is reported only after the stream ends or fails.
- **A stream error after the session has returned is uncaught.** The `finally` removes the frontend's error listeners, so an `error` emitted after `runRepl` returns has no listener. Bun then exits with status 1 and prints a stack trace (verified). The process ends and the failure is not lost, but it is not reported as a session failure (N4).
- **Thrown values are not always normalised.** `runRepl` turns a thrown reply error into a failure for that turn. The catch assumes the thrown value is an `Error`, so a thrown string prints `error: undefined` (verified). `compact` and the REPL's catch normalise the thrown value, but `src/providers/openrouter.ts` still casts `(error as Error).message` in its three catch blocks. The `ContextWindow` calls in `showContext` and `compactIfNeeded` sit outside that boundary, so a throwing lookup rejects `runRepl` instead of returning an error.
- **Model errors name the provider.** `src/tools/models/select-model.ts` says `OpenRouter does not list <name>`, so a second provider would print the wrong name. The error should name the model and be built from the Provider contract, not from one adapter.

#### Turns and output

- **Tool lines appear late.** A call's line is printed after the reply has ended, because the call is complete only when the stream finishes. A long reply therefore appears before the call that caused it.
- **Markdown is a subset with edge cases.** It applies to model replies and to `.md` files in the viewer. Headings deeper than three `#` show their hashes as text, and a paragraph line that begins with digits and a period (for example `2020. was a year`) opens a numbered list. A line of three asterisks is read as a bullet. Tables are not supported, and an image (`![alt](src)`) shows a stray `!` and its alt text. Underscore emphasis (`_text_`) is not supported. A link shows its text and drops its address, by design. Each is a known gap of the subset, not a rendering error.
- **Partial replies stay on screen.** When a model stream fails, `streamChat` yields an `err` result, and `runRepl` drops the user line from the history, so no truncated answer is recorded. The text already printed is not marked as incomplete, and nothing tells the user it was discarded.

#### Context and compaction

- **The stored prompt size is set only by completed requests.** A completed request records its size and clears the compacted flag. A compaction clears the size, so `/context` reports it as unknown rather than "no request sent yet". A failed request does not record its size. A failed compaction keeps the conversation unchanged, so the next message tries again. The automatic check uses the size of the previous request, not the request about to be sent, so a message that adds many tokens can overflow the window before the next check.
- **`/context` may not match the last line.** The count is from the last request that reported usage. A later request that failed is removed from the history, but the earlier count stays, and the output does not say which request it belongs to.
- **Compaction keeps roles alternating by merging.** When the first kept message is a user message, the summary is merged into it. If the first kept message is an assistant message, the summary stands alone as a user message. Either way the roles alternate.
- **The summary is invisible.** Summary chunks are collected without being written. The user never sees what the model kept, and the "history compacted" line does not say what was dropped. Everything older than the last six messages is gone from the session with no record shown.

#### Models and reasoning

- **Reasoning is not kept in the history.** `AssistantMessage` has no field for reasoning, and `toWire` sends an assistant message with only its text and tool calls. The stream's `reasoning_details` are read for the thinking count and then dropped. The provider expects the reasoning of a tool-calling message to come back unchanged, so with `/thinking` on, the second round of a tool loop may fail. This is unverified and needs a live probe with a tool call.
- **The shared stream names OpenRouter for every server.** `streamChat` in `src/providers/openrouter.ts` words its errors with OpenRouter (`OpenRouter returned 500`, `OpenRouter stream ended`), and llama.cpp replies use the same stream, so a llama.cpp failure reads as an OpenRouter one. The stream also sits in the OpenRouter module, so `llama-cpp.ts` depends on an adapter (see the dependency rule).
- **No timeout and no cancellation.** A request that never completes leaves the prompt blocked, with no way to abort it.

#### Tools and approval

- **`ask_user` and `run_subagent` skip the switched-off check.** `runCalls` (`src/backend/calls.ts:46-65`) starts both before any check of `step.offered`, and `runTool`'s check (`src/tools/run-tool.ts:41-44`) is never reached for them. A model that calls `ask_user` after the user switched it off, or after a profile's whitelist left it out, still asks the user a question. This breaks the rule that a switched-off tool is refused without approval.
- **`/exit` at an `ask_user` question is sent to the model as the answer.** `receive` (`src/backend/session.ts:157`) parses an ask question's line with `parseAskLine` only. Unlike an approval, it does not read `/exit` as an exit (`answerOfLine`, `src/core/commands.ts:210`), so the session goes on and a request follows. This breaks F1 and the Approval section's rule that `/exit` during a question ends the session.
- **An open question's kind is implicit.** `OpenQuestion` (`src/backend/session.ts:37-42`) has an optional `choices` that tells an approval from an ask, and `Reply` is `ApprovalAnswer | AskReply`, so a bare string means a refusal to an approval and "no answer" to an ask. `receive` checks `choices` in three places, and nothing enforces the pairing.
- **A request with no tools field is unverified.** With no tools switched on, `streamChat` omits `tools`. A history that already holds tool calls and results may then be sent without tool definitions. Whether OpenRouter accepts that has not been checked. A profile's `tools:` whitelist reaches the same case: a history with calls to tools the profile does not allow is sent with those tools left out.
- **`/tools` and the tools panel ignore a profile's whitelist.** `toolStates` prints each tool as on or off from the switches alone, and `runToolsCommand` passes it only `disabledTools`. The `tools` event is built the same way (`toolSwitches` in `announceTools`), so the page's panel also shows `on` for a tool the active profile does not allow. `/tools enable` reports it on while it is still not offered.
- **`edit_file` rewrites bytes outside the edit.** `editFile` reads the file as UTF-8 and writes it back as UTF-8, so any byte that is not valid UTF-8 becomes U+FFFD in the whole file (verified: `61 ff 0a 62` edited to `c` gave `61 ef bf bd 0a 63`).
- **The approval preview hides what will change.** It prints `previous` and `replacement`, not the line of the first match, nor how many matches there are. The write replaces the first match at the time of the write, so a file changed during the question can put the first match somewhere the user did not see. The preview also shows the path as typed, not the real location a link resolves to.
- **`/undo N` ignores N.** `classifyLine` splits the words with `/s+/` (a literal `s`), not `/\s+/` (`src/core/commands.ts:130`), so `/undo 3` has no words and reverts one turn. The test that pins it (`src/core/commands.test.ts:163`) fails on the committed code. The wrong turn is restored with no message that says so.
- **A turn with no changes is still a point.** `startTurn` runs for every message, so after a question that changed no file, `/undo` (1 turn back) restores nothing and drops that turn, and the edits of the turn before stay. The notice says "restored no files", not why.
- **A folder change waits for the running turn, and a failed start ends the page's session.** A switch waits for the current turn to finish before the new session starts. If the new folder's configuration is broken (for example an invalid hooks file), the session ends with that error, and the page must be reopened to continue. The process has already moved to that folder, and the exit status is 0, so the terminal shows no error.
- **The folder input is hard to use.** Its box is 21px tall beside a 42px Switch button (`src/web/client/view.ts`, `folderBar`), the "Folder" text is not a `<label>` for it, and only a placeholder names it.
- **A folder request after the session has ended leaves the page waiting for good.** `run` (`src/web/server/handover.ts:88`) returns when `relay` sees `ended` without `ending`, and nothing restarts. `requestFolder` (`handover.ts:36-45`) still sets the phase to `ending` and sends `inputEnded` to the ended session, so every later line is refused with the folder notice and no session starts. The same happens if the session ends while the dialog is open: the `then` at `handover.ts:55` sets the phase back to `running` and then calls `requestFolder` on a session nobody relays. (By reading the code; not run.) A request made when no session is running should answer with an error, and the end of a session should be a state the phase machine checks.
- **A failed folder dialog leaves the page waiting, and its rejection is unhandled.** `pickFolder` (`src/tools/process/folder-picker.ts:13-23`) calls `Bun.spawn` outside any `try` or `Result`, so a missing `powershell.exe` rejects it. `handover.ts:54` has no `catch`, so the phase stays `picking` and the notice blames a folder change that never began. `run-powershell.ts` wraps its spawn; the picker should do the same. (By reading; not run.)
- **The folder dialog has no time limit and is not released on exit.** It is a child process outside the job registry, so an interrupt with the dialog open is not covered by N3 (see the stop paths under Background jobs). While it is open, input is refused with "the folder is changing", which is not true yet.
- **Undo covers file tools only, and its records are in memory.** `/undo` reverts edits and creates made by `edit_file`, `create_file`, and `create_note`. A command run with `run_powershell` is not recorded, and the conversation still shows the edits. Every turn keeps its full record of the bytes before its changes, and no byte limit exists, so memory grows with the bytes of the files changed for the whole session. Thinning the offered points does not reduce it, since any turn can lie inside a later point's window. A revert that fails part-way restores the files it reached, leaves the log's turns in place, and updates the expected bytes only for the files it restored, so a later `/undo` plans from a state the user never saw.
- **A failed edit still records a change.** `around` records the bytes before the call, and the call runs even when it fails (for example, no match), so a turn can list a file it did not change. The revert then rewrites that file with the same bytes.
- **`create_file` previews the whole content.** A large file floods the terminal before the question, and the user answers after scrolling past it.
- **`resolveNewInside` reports a misleading error when an ancestor is a file.** For `a.txt/x.txt` where `a.txt` is a regular file, folder creation fails with EEXIST, and `createFile` reports "the file already exists" for `x.txt`, which does not exist (verified).

#### Background jobs and processes

- **Background job gaps.**
  - (i) `killAllJobs` retries a job whose stop failed up to three times, then removes it from the registry and returns it, so `index.ts` can name it. Once removed, a job whose process still runs cannot be retried by a later stop.
  - (ii) A job's status is set by its exit handler and by `killJob` after `taskkill`. A stop that completes after the handler has run leaves the status `exited`, so `readJob` reports an exit the model did not cause. The status should come from one place.
  - (iii) `readJob` removes a job at the first read after it has ended, even when its output is still arriving. A job that is never read stays in the map for the session, and `MAX_JOBS` counts only running jobs. (Verified: a job whose child kept a pipe open returned the output so far, and a second read reported no job.)
  - (iv) `Tail` cuts each line at 8192 characters, counting UTF-16 code units, so a cut can split a surrogate pair.
  - (v) `index.ts` calls `killAllJobs` only on the return path after `runRepl`. It is skipped if `runRepl` throws, and nothing in `src/` handles interrupts. What happens to a running job on Ctrl+C depends on the runtime and is not verified.
  - (vi) `kill_command` does not stop children that outlive their parent, for the same reason as the `run_powershell` gap below.
- **`run_powershell` can keep the process and its pipes after the call returns.** A finished command returns after a one-second grace period, even when children hold the output. Two gaps remain, both verified. (a) When PowerShell exits normally with a child still holding its output, no stop is applied. The call returned at 1.3 s, but the process could not exit until the child ended (a `Start-Process ping -n 40` kept it alive for 39 s), and the child was never stopped. (b) `taskkill /T` cannot reach a child whose parent has already exited, so fixing (a) needs a Windows Job Object that kills its processes when the job closes. The `taskkill` call itself has no bound.
- **`bun run web:dev` has two gaps.** `scripts/web-dev.ts` (not part of the session, and outside `index.ts`'s exit path) has these gaps. (c) On Windows, `taskkill /T /F` ends the server's tree before `index.ts` can finish stopping its jobs, so the job warnings are not printed. (d) `stop()` waits without a bound if the server does not exit after SIGINT.
  - (e) The token is kept across restarts, so a URL copied earlier works until Ctrl+C rather than until the next restart. Its environment variable (`VISE_WEB_TOKEN`) is read and removed at startup, before any server or hook starts (`takeWebAddress` in `src/web/server/address.ts`). Every child process gets a copy of the environment without it and without `OPENROUTER_API_KEY` (`childEnvironment` in `src/tools/process/child-env.ts`).
  - (f) `webAddress` maps any value that is not a valid number to port 0 without a message, so `abc` or `1.5` silently gives a new port on each start, and the open page cannot reconnect. Integers outside the port range (for example `70000`) reach `Bun.serve` and fail there. The variable should be parsed strictly and an invalid value returned as an error.
  - (g) `freePort` releases the probe port before the server binds it. If another process takes the port in between, the server fails to start, and `web:dev` waits for the next file change; it does not retry the same start.

#### Providers

- **A save can lose a key, and a crash can leave the file half-written.** `saveServers` (`src/providers/config.ts`) reads the file, builds the new list, and writes it with `writeFile`, which truncates the file first and is not atomic. The session starts each save with `void`, so two saves can run at once. The second reads the file before the first has written it, and a blank key in the second keeps the older key, which replaces the newer one (checked by running two saves in a temporary folder: a new key was overwritten by the old one). A crash or kill during the write leaves an empty or partial file, and the next start exits with "not valid JSON", so the keys are lost until the file is repaired by hand. Missing control: the save writes a temporary file in the same folder and renames it over the old one, and saves run one after another through a queue in the store.

#### MCP servers

- **Chamfered controls hide their focus rings, and the light Send button fails contrast.** `style.css` clips the buttons, the theme select, the composer's textarea, and the approval, profile-editor, and file-viewer boxes with `clip-path` (the last block of the file). A clip-path removes everything outside the box, and the default focus outline lies outside it, and no `:focus-visible` rule draws one inside. A keyboard user therefore sees no focus on those controls. The Send button sets dark text (`#1d1d1b`) on the light accent (`#8a6a1c`), about 3.4 to 1 (estimated from the colours, not measured), below the 4.5 to 1 that 16px text needs. The chamfer list also skips the file tabs, the Source and Rendered button, the profile editor's selects and inputs, and the folder input, so square and cut boxes sit side by side. Missing control: a focus style drawn inside the box, and a contrast check for each accent pair.
- **The MCP panel drops a server the file no longer configures.** `mcpPanel` (`src/web/client/mcp-view.ts:39`) lists only the configured servers. A server that started and was then removed from the file shows only its problems, not its state or tools, until the next start. - **The server editor's row breaks its grid.** `.profile-editor .server-row` (`src/web/client/style.css:312`) is a three-column grid, but a row has five children: the kind select, the name, the program fields, the endpoint fields, and Remove. With the kind set to endpoint, at 974px wide, the select and the name input stretch to 180px tall, and Remove drops to a second row (verified in the browser; the hidden fields take no cell, and the row's cells stretch because the grid aligns them to stretch). The fields are labelled, but the labels sit beside a stretched input, so the row reads as one tall block. The row needs its own layout: the field groups span the full width, and the cells align to the start.
- **The MCP section copies a helper and borrows other styles.** `element` is defined in both `src/web/client/mcp-view.ts:24` and `src/web/client/view.ts:41`. The section reuses the `sessions` and `profile-editor` classes, so its look follows those other sections.
- **MCP servers received the API key and the web token (fixed).** `openSession` (`src/tools/mcp/client.ts`) now passes `childEnvironment(process.env)`, as `run_powershell` and the `taskkill` in `jobs.ts` do, so neither name reaches a server, a command, or a stop. The filter does not stop a program the repository ships from reading `.env` from disk (see Security).
- **Servers start before the session is ready and are not stopped on an early interrupt.** `startMcpServers` runs before any line is read and before the `sessionStart` hooks. A server that does not answer costs up to 60 seconds per handshake and per `tools/list` page, and the servers start one after another. `servers` stays empty until `index.ts:166`, so a Ctrl+C during startup runs `stopEverything` on nothing, and the servers already started are left running. (By reading the code; not run.)
- **A name that looks external asks for approval even when no server offers it.** `needsApproval` treats any `<x>__<y>` name as an MCP tool (`src/core/tool-lines.ts:32`). A call to a name no server offers is previewed and approved, and only then fails with "unknown tool" (`src/tools/run-tool.ts:41`, `dispatch`).
- **A read error on a server's output is unhandled.** `src/tools/mcp/client.ts:57` runs `readLines` with `void` and no `catch`, so a failed read on a server's stdout is an unhandled rejection rather than a server failure (N4).
- **The composition root is not the only place that reads the environment.** `run_powershell`, the MCP client, and `jobs.ts` read `process.env` to build the child environment, against the Definitions entry for the composition root and N1. The filter is the single place that decides what is withheld.
- **The HTTP client reads each answer to the end of its body.** `answerTo` (`src/tools/mcp/http-client.ts:80-86`) waits for `response.text()`. An event stream that stays open after its answer, which the transport allows, holds the request until the 60-second limit, and the request then fails although the answer arrived. Every call and every start is slowed by that limit. The stream should be read event by event, and the request should return at the event that answers its id.
- **Session expiry is not handled.** A server that answers 404 to a request carrying `Mcp-Session-Id` has ended that session. The transport requires the client to start a new one, with a new `initialize`. `openHttpSession` (`http-client.ts:43-47`) reports the 404 as a failed call, and no later call recovers.
- **The HTTP client follows redirects with the headers.** `fetch` (`http-client.ts:35`) follows a redirect by default and sends the entry's headers to the new address. A redirect to another host can receive the token.
- **The HTTP client sends the configured headers over plain HTTP.** `parseHttp` (`config.ts:83-107`) accepts an `http:` URL for any host, so an Authorization value sent to a non-local endpoint is not encrypted.
- **Endpoints are contacted before any approval.** `initialize`, `notifications/initialized`, and `tools/list` go to each endpoint with its headers at session start, before any line is read, and the DELETE goes to it at exit. This is the file's trust, not a per-call approval (see Security).
- **A program entry accepts headers and ignores them.** `parseEntry` (`config.ts:66-80`) does not look at `headers` on a stdio entry, so a `headers` key next to a `command` is accepted with no message.

#### Hooks, instructions, and profiles

- **Instructions errors are hidden.** `readInstructions` returns undefined for every read error, so a permission error or an `AGENTS.md` that is a folder is treated as no file, with no message. The backend adds the instructions to the first message of each request (`withInstructions` in `src/core/messages.ts`, used by `runMessageTurn` in `src/backend/turn.ts`), so the stored history does not hold them.
- **A saved session from before this change holds `AGENTS.md` in its first message.** The page strips only the current text (`historyMessages`), and a request adds the current text in front of the stored text again, so the model sees both versions when the file has changed since. Missing control: a migration that removes the old prefix from saved sessions on load.
- **The compaction and subagent requests do not carry AGENTS.md.** `compact` in `src/core/compaction.ts` sends the stored history to be summarised without the instructions, so the summary may leave out project rules. A subagent's loop in `src/backend/subagent/subagent.ts` builds its own history and never adds them, so a subagent runs without the project's instructions. Missing control: one place that builds every request from the instructions, with the request kinds that exclude them named in the code.
- **`withInstructions` skips a history that does not start with a user message.** It returns the history unchanged, so the instructions are dropped with no message. No current path builds such a history, but a damaged resume file could. Missing control: an error in place of the silent skip.
- **The display strip covers only the instructions.** The first user message also holds a pending profile and pending hook output (a `sessionStart` hook's output is queued into it), and the page shows those as part of the user's text on a resumed session.
- **Saved sessions and the resume file from before this change hold a copy of `AGENTS.md`.** Those written before the instructions were kept out of the history hold the text inside their first message, so a copy of the project file sits in the user's home folder or `.vise/sessions/`. Missing control: the same migration as above, which would remove the copy.
- **A timed-out hook is not stopped.** Every point's output is printed, sanitized, cut at 4000 characters, and queued for the next message. A `sessionEnd` output is printed but never sent, since the session has closed, and a `turnEnd` output queued just before `/exit` is printed and not sent. A hook still running after 30 seconds is reported as failed, but its process keeps running as a background job that takes one of the five job slots and whose output nobody reads. A line containing the `[exit code N]` or `[still running` marker can be mistaken for the runner's own marker.
- **Profile switches stack.** A switch appends the new profile's text, and the earlier text stays in the history. `/profile default` does not remove it either. Until compaction, the model sees both profiles as user text, and both are in effect. The switch does not say which profile now applies.
- **Profile transitions are in the frontend.** `runProfileCommand` in `src/repl/repl.ts` builds the new `Conversation` for use and clear, the same kind of transition as `compact`. The failed-turn restore of `pendingProfile` has no test.
- **An empty `tools:` line offers no tool.** `parseHeader` reads a `tools:` line with no names as an empty list, and `enabledTools` allows nothing for it. The profile blocks every tool with no message (verified).

#### Commands and model search

- **The model search rule lives in the frontend, and its order depends on the locale.** `runModelCommand` in `src/backend/commands/commands.ts` filters and sorts the listing. The sort uses `localeCompare`, so `["Ab", "aa"]` sorts as `aa, Ab` in one locale and `Ab, aa` under the default sort (verified). No test pins the printed order; the `/model search` test checks only which models match.

#### Saved sessions and settings

- **A saved session can hold a history the provider rejects.** `decodeSession` checks the shape of each field, the tool names, and the pairing of tool calls with results, but not the role order a live turn keeps. A hand-edited file can load a history that every later request rejects, and `/compact` sends it too.
- **A saved session without a tools field loads with every tool on.** `disabledTools` is optional in the file, so an older or hand-edited file re-enables any tool the user had switched off, with no message.
- **Autosave names can overwrite a session.** The name is chosen from the listing before the first turn runs and is written only after the turn, so two sessions in one folder can choose the same name and the second overwrites the first. A first turn that fails leaves an empty session under the name of a message the conversation no longer holds, and the "autosaving as" notice follows the error even when that first save failed. Missing controls: compare names in lower case, reserve the name when it is chosen, and announce the name only after its first save succeeds.
- **Saving overwrites in place.** `/save` writes the file directly, so a failure part-way leaves a damaged file where the previous session was. An existing name is replaced with no warning.
- **Tool settings are read and written in different places.** `index.ts` reads `.vise/tools.json` and passes the names through `SessionPorts`. `/tools` writes the file through the `SaveDisabledTools` port. If the write fails, the switch still applies for the session, and the error line is the only sign that it was not saved.

### Nonfunctional

#### Testing

- **Stream-level tests must cover lines that arrive together.** Readline delivers every line in a chunk at once, so lines already buffered after `/exit` are still yielded by the loop unless the loop stops at the exit line. Tests must cover lines that arrive in one chunk, not only one chunk per line.
- **Session tests are not beside their module.** The session format tests sit in `src/core/compaction.test.ts`, and `src/core/sessions.ts` has no test file of its own.

#### Build and dependencies

- **`@types/bun` is unpinned.** It is set to `latest`, so type checks can change without a code change.
- **`typescript` is only a peer dependency.** A fresh install does not provide the compiler the checks need.
- **The file-count check ignores untracked files.** `scripts/check-files-per-dir.ts` reads `git ls-files`, so a new file counts only after it is staged.
- **Directories are at or near the file limit.** `src/core` and the repository root hold ten tracked files each, the limit, so the next file in either must merge with another or move into a folder.
- **No formatter is configured.** The linter enforces size and correctness rules, not formatting.

#### Architecture

- **Tool definitions are spread across modules.** `src/core/tools.ts` (about 470 of 500 code lines after `ask_user`, the limit) and `runTool`'s dispatch each add a branch per tool: the spec, the argument parser, the approval preview, and the call line in `tools.ts`, then the target check and the dispatch in `run-tool.ts`. The same file also holds the `/tools` words, the terminal `sanitize` helper, and the approval rule. Roughly three more tools would breach its file limit.
- **The turn loop is written twice.** `collectRound` in `src/backend/subagent/subagent.ts` repeats `streamRound` in `src/backend/turn.ts`. The subagent's tool-call loop repeats the round loop of `runMessageTurn`, with its own limit and its own history handling. A fix to one (a failed round, a finished session, a summary line) must be made to both.

#### Responses and schemas

- **Response schemas can drift from OpenRouter.** The zod schemas in `src/providers/openrouter.ts` are hand-written, and the test fixtures come from the same assumptions, so a change on OpenRouter's side passes the tests and fails only at run time. `choices` and `usage` are `optional`, not nullable, so a `null` there fails the whole stream. `ModelListingSchema` requires every entry of `data` to match, so one model with a `null` `context_length` makes `/context` fail for every model. The error text from zod is printed verbatim. The schemas and the hand-declared types (`StreamEvent`, `Usage`) are two sources of truth. The error does not say which request failed.

#### Cost and size limits

- **Tool rounds are unbounded, and each is a paid request.** Nothing limits the rounds, the calls per round, or the total output. This is accepted by the user, but the cost and time must be visible as they happen, and a looping model must be stoppable with Ctrl+C.
- **The history is not bounded.** Compaction runs on `/compact` and before a message once the last prompt reached 80% of the window. Between compactions the history is resent in full, and no `max_tokens` is set, so one reply is unbounded.
- **`list_files` output has no size limit.** A listing returns every file name up to the depth, with no cap on the count, and includes large folders such as `node_modules`. The whole listing becomes one tool message, sent in every later request until compaction removes it.
- **`read_file` reads the whole file before the range is cut.** `readFileLines` loads the file, splits it, and only then applies the 500-line cap. The cap counts lines, not bytes, so 500 lines of 1 MB each come back whole and enter the history.
- **MCP results are neither capped nor framed.** A server's result text goes into the history as it is, with no size limit and no data framing (see Prompt injection). A server that answers with a very large result fills the history, as the cap on `read_file` and `list_files` output is not yet written (see above).

#### Model cache

- **`/thinking` may cost a cache miss.** `/thinking` sets a request field and does not touch the messages. A change to the thinking configuration can still invalidate the cached prefix, as a change to the tools does (N6). The user is not told this. Not yet verified against OpenRouter.
- **A model switch carries the old model's reasoning and misses the cache.** `/model <name>` keeps the history, so the reasoning items the previous model returned are sent to the new model with the next request. Whether OpenRouter rejects another model's reasoning is unverified. The first request after the switch also misses the cache, and the switch line does not say so.

## Security

### Trust boundary

Everything read from stdin, or sent over the browser socket, is untrusted text, and every line is sent to OpenRouter, a third party. The model's reply is also untrusted text. Vise reads file names and file contents under the working directory for `list_files` and `read_file` (hidden entries are skipped, and paths are checked on their real location). The page's file tree reads the entries of one folder when the user opens it, by the same rule, and the page sends only the folder's path. A click on a file sends its path, and the page receives that file's text (at most 1 MB, text only, not hidden). The page holds the text and never sends it to the model. It writes files only through `edit_file`, `create_file`, and `create_note`, after the user approves each change on the terminal. `create_file` and `create_note` never overwrite. The writes without an approval are the ones the user types or clicks: `/note new` writes a note, `/tools enable` or `/tools disable` writes `.vise/tools.json`, `/undo` puts back files that Vise changed (refusing any file changed outside Vise), and the page's own saves write a profile or `.vise/mcp.json`. None takes model text. Vise starts PowerShell only through `run_powershell`, after the user approves each command, and through the folder dialog, which the page opens with its own click and which takes no model text and writes nothing. The command runs in the working directory. A command still running after 30 seconds becomes a background job that runs until the user approves `kill_command` for it or Vise exits, and its output is kept as its last 500 lines per stream. A child that outlives PowerShell is not stopped by `kill_command` (see Known Problems). The OpenRouter key comes from `.env`, and each llama.cpp key comes from `.vise/providers.json`. Neither may be echoed or logged, and neither is put in a child process's environment or sent to the page.

### Trust in files and settings

- **Subagents act with the user's permissions.** A subagent's writes and commands go through the same approval queue as the main conversation. A subagent's profile can list commands in its hooks, which run without approval as described under Hooks, so a subagent run by a profile from a cloned repository inherits that trust.
- **MCP endpoints receive the tool arguments and the headers.** An entry with a url (HTTP) sends every tool call's arguments to that address, a third party when it is not the user's own server, and sends its headers with every message, including the start-up handshake and the DELETE at exit. A header value such as an Authorization token is kept in `.vise/mcp.json` in plain text, as the editor saves it. `.vise/` is git-ignored, so the file is not committed. The page and the `mcp` event receive each header name with a blank value; a blank value on save keeps the value already stored for that header. A redirect is refused, so headers do not reach another address. Plain `http:` to any host is allowed, so a token sent to such a host travels unencrypted. Missing controls: a stored value that is not on disk in plain text (the choice between a separate secrets file and an in-memory prompt is open), and showing the address and the headers before the first contact with an endpoint.
- **MCP servers run programs without approval.** `.vise/mcp.json` names programs that Vise starts when the session starts, with the user's permissions, before any line is read. A repository that ships this file runs its programs at startup, the same trust as `.vise/hooks.json`. The page can also write this file (see The page's MCP section under Behaviour). A save from the page is the user's own action, so it is not asked again, and the program it names starts at the next start with the same trust as a file the user wrote. Each tool call is approved by the user, with a preview of its arguments. The server's tool names and descriptions are sent to OpenRouter with every request, so a server can put instructions in front of the model without any call being made. Missing controls: a per-repository consent record kept in the user's home folder and keyed by a hash of the file's content, asked on the terminal before any server starts, so a changed or new file asks again; the page refuses to start the servers until that consent is given; and each server's command and arguments are shown at that point. Hooks have the same gap, and the same fix should cover both files.
- **Llama.cpp servers receive the conversation and the key.** `.vise/providers.json` names each server's URL and key. Every request to a server, including the model listing and `/props`, carries the key as a bearer token, and every message of the conversation goes to that URL. A file a repository ships could point a server at a third party, so the file is as trusted as `.vise/mcp.json`. The consent control under Controls is missing for it, as for the other files, and the URL should be shown before the first request. The page can also write this file, keys included, through the Providers panel; the page receives no key back, only whether one is saved.
- **Hooks run commands without approval.** `.vise/hooks.json` is trusted: any command in it runs with the user's permissions at the four hook points. A repository that ships this file runs its commands when a user starts Vise there. This is a standing approval given by a file, not by a command. `.vise` is not git-ignored, so the file can arrive in a clone.
- **Hook output reaches the model.** A hook's output is sent with the next user message, so a hook that prints file contents or secrets sends them to OpenRouter. The printed output is capped at 4000 characters. Whether the cap also applies to the text sent is not clear from the code, and it needs checking (see Known Problems).
- **The resume file is read at start.** The conversation from the last run is sent to the model with the user's authority, without a command. Only a process that can write to the user's home folder, or the user, can put a conversation there (see Resume for where it lives and what it restores).
- **Saved sessions are read from disk.** `/load` reads `.vise/sessions/<name>.json`, which the user wrote with `/save` or which came from elsewhere. A loaded file puts its history into the next request with the user's authority, sets the pending profile text, and sets the switched-off tools. Only field types and tool names are checked. Missing controls: a structure check of the history, a summary (message count, profile name, switched-off tools) shown before applying, and framing as saved context rather than the user's words.
- **Profile text.** A profile's text is sent as user text, with the user's authority, each time it is switched in and after each compaction. It may come from a file the user did not write (a cloned repository), or from model-written text the user approved. `/profile` shows only the name, not the text or its size. The loader confines reads to the working directory, and the text is captured at the switch. Missing controls: showing the text and size on the switch, capping the size with a defined response, and framing the text as profile-supplied.
- **The page can write a profile.** `profileWrite` changes the file at `notes/profile/<name>.md` if it exists. The containment check follows links and writes to the real target, so a link there reaches any file inside the working directory. The store does not check that the existing file is a profile (its category), so a non-profile file in the folder is overwritten. Missing controls: refuse the write when the real target is outside `notes/profile`, and when the existing file is not a profile; the server also refuses a write while an approval is open, which only the page does today. The request is the user's own action in the page, so it is not approved line by line, as `/note new` is not. Its hooks then run at their points without approval, as any profile's do. The check on the detail stops a malformed file, not a hook the user meant to write.
- **Project instructions file.** `AGENTS.md` is read from the working directory, which may be a repository the user did not write. Its text is sent to OpenRouter at session start without the user typing it, and it carries the user's authority in every request. Missing controls: showing the path and size and asking before the first request, capping the size, and framing the text as project-supplied.

### Controls

Status is **missing**, **partial**, or in place.

#### Input and model output

- **Browser output (in place).** The page sets model text, tool lines, previews, and errors with `textContent` only, never as HTML, so model output cannot run as markup in the page. Replies, and `.md` files shown in the viewer, are read as the Markdown subset in `src/web/client/markdown.ts` and built as elements by `src/web/client/render/markdown-dom.ts`; a link keeps its text and drops its address, so model text never sets an `href`.
- **Terminal escape injection (in place).** The renderer (`src/repl/render.ts`) sanitizes every line the backend emits: model text, tool lines, approval previews, notices, and errors. `sanitize` replaces control characters other than tab and newline.
- **Prompt injection (missing).** Model replies, earlier replies resent in history, and text read from files can carry instructions the model then follows. `list_files` returns file names and `read_file` returns file contents, and both are model input. A file the model reads can carry an instruction into the next request, and an injected instruction can make the model call `read_file` on a file the user did not mean it to read. The output of `run_powershell` is model input too. Any action taken from model output must be confirmed by the user and must not be reachable from text the model produced alone. Compaction is a second persistence path: a model-written summary becomes a user-role message in every later request, so an injected instruction survives compaction with more authority than the reply it came from. Data framing for tool output is missing.
- **Unbounded input (partial).** Job output lines are cut at 8192 characters and marked. User input, model replies, and file reads are not limited. Input needs a maximum line length with a defined response when it is exceeded.
- **Model output (in place).** The renderer strips control characters other than tab and newline from model replies before writing them.

#### Files, writes, and commands

- **Containment and hidden paths (partial).** A path is resolved against the working directory and refused when it lands outside it. The real locations of the working directory and the target are compared (`realpath`), so a junction or symbolic link inside the working directory cannot lead outside it. The hidden rule (a path component starting with `.`) applies to the typed path and to the real path relative to the real root, so a non-hidden junction to a hidden folder such as `.git` is refused. Both checks are in `resolveInside` (reads, lists, edits) and `resolveNewInside` (creates). For a path that does not exist yet, the existing ancestor is checked through its real location, and the part below it is checked as typed. A dangling link there fails with ENOENT when the folders are made (verified with a junction to a hidden folder, a junction outside the working directory, and a dangling junction). `createFile` runs the check again after approval, but the folders are made after that check, so a link created in the gap between check and `mkdir` is followed. The `wx` flag protects only the final file. Closing this gap needs a local process racing the tool, which the model cannot do alone.
- **Approval integrity (partial).** The approval question is the only control on writes, and it shows model-written text. The preview is sanitized, but it still shows the path as typed rather than the real target, and it does not show the line of the first match. `edit_file` writes whatever bytes it finds at write time. A write or command is approved only by a line typed after the preview (F4), but the question reads the next line of input, so a line typed earlier that is still queued is taken as the answer (see Known Problems). The `run_powershell` preview shows the command text only, not the working directory's real location or what the command can reach (missing).
- **Writes change the file they were approved for, not the text (missing).** An approved edit is applied to whatever file is at the path at write time, after a read that is not compared with the one shown. The fix is to record the matched line or a hash with the approval and refuse the write when the file differs.
- **Command execution (partial).** `run_powershell` runs the model's command with the user's own permissions, in the working directory. The working directory does not confine it, so the command can read, write, delete, or send any file the user can reach, including over the network. The per-command approval and the approved stop of a background job are in place. Missing: a stop that reaches children outliving PowerShell, a sandbox or restricted account, an approval that states the working directory and permissions, and output framed as data. Any further command-running tool must be explicit, reviewed on its own, and reachable only through an approval given after its preview.

#### Data, spending, and secrets

- **Data exposure to a third party (missing).** Every line and every earlier reply is sent to OpenRouter, and the history is resent in full each turn. The names and contents of files the model reads are sent too, on every turn that uses a tool, not only what the user typed. `run_powershell` output is sent as well, and its command can read files outside the working directory. `read_file` sends file contents the model asked for, while the user sees only the path and line range in the tool line. Users must be told this. The controls are a confirmation or announcement before a content read is sent, a cap on listing size, a cap on content size, a per-session cap on history, compaction the user can see, and a `max_tokens` limit. Compaction exists, but its summary is not shown, no `max_tokens` is set, and neither the listing nor the content has a cap.
- **Unauthenticated spending (partly addressed).** Any process that can write to the REPL's stdin spends the user's OpenRouter credit, and the terminal frontend has no check beyond that. The browser frontend listens on 127.0.0.1 only, and accepts its socket only with a random token printed once in the URL (sent in the fragment, so it is not sent to the server as part of the page address) and only from its own origin. So another web page cannot drive the session, but any local process that can read the URL can. Under `web:dev` the port and token are the same for every restart of the server, so the token lives until `web:dev` ends (see Known Problems). No rate or spend limit exists.
- **Secrets (partial).** Child processes do not receive `OPENROUTER_API_KEY` or `VISE_WEB_TOKEN`: `childEnvironment` removes both from every spawn (`run_powershell`, MCP servers, `taskkill`). Missing: a test that checks a spawned child cannot read them, and logging control (see the next item). The key is also readable from `.env` in the working directory, so a process a repository ships can read it from disk; the consent control under Trust in files and settings is the control for that case. The llama.cpp keys in `.vise/providers.json` are not in the environment, so no child process receives them, but they sit in plain text on disk, as MCP header values do. The page never receives them.
- **Logging (missing).** Vise must never log input lines to a file by default, since users may paste secrets. No logging exists yet. A saved session holds every line typed in plain text, including any pasted secret, and `/save` does not say where the file is. The resume file holds the conversation the same way, and it is written after every line, in the user's home folder.

## Future Work

### Functional

#### Turns and requests

- Bound the tool loop with a user-visible limit and a way to stop it (Ctrl+C through the `AbortSignal` below). The user chose no limit today; the architecture should still make the stop possible.
- Thread an `AbortSignal` from the frontend through the reply function into `fetch`.
- Print each tool line when the stream signals that the call is complete (its `finish_reason` chunk), not after the whole reply. Sanitize the call's name and path with the same control as model text.
- Keep the reasoning items of a tool-calling assistant message in the history, verbatim, and send them back in later requests with thinking on. Probe the provider with a tool round first.

#### Input and the session

- Move the DOM helper that `view.ts` and `mcp-view.ts` both define, and `panelBox`, into one module under a subfolder of `src/web/client` (such as `panels/`), so the client's top level stays under its file limit. Each list builder returns its items without a heading, and the panel owns the title and count. Give the MCP section its own CSS classes.
- Make `fileText` and `tree` required ports in `src/backend/ports.ts`. The composition root always passes them, and a session that lacks one answers with an error event that names the request.
- Announce, when a question discards queued lines, how many were dropped.
- Give the turn loop one explicit session-ended state, set when input ends (the readline `close` event), on a stream error, or at `/exit` during a question. Check it before every request and before every tool call. Queued lines still count as input to answer, so the check reads the queue rather than a separate flag. Only the queue-empty case stops the loop.

#### Browser layout

- Clamp the stored column widths on read (see Known Problems), using the same minimums and room as `setWidth` in `separators.ts`.
- Add an `event.button === 0` check to the separators' `pointerdown`, so a right-click does not start a drag.

#### Errors and exit

- Handle late stream errors (N4): `runRepl` accepts an `onLateError` callback from the composition root, and the frontend keeps a listener on input and output after the session ends that forwards to it. `index.ts` prints the error and exits 1.
- Make the shutdown report run on every exit path of `index.ts`, not only when `runRepl` returns: a `try`/`finally` around the REPL, plus a handler for interrupts.

#### Tools and approval

- **One gate for every model call (the next change to make).** `runCalls` checks each call against the offered tools, with the same function, before it branches to `ask_user`, `run_subagent`, or `runTool`. `runTool` keeps its own check, so a second caller is still refused. The refusal text is the same for every tool, and a test covers each tool that the backend starts.
- **The open question is a tagged union.** `OpenQuestion` becomes `{ kind: "approval", resolve(answer: ApprovalAnswer) } | { kind: "ask", choices, resolve(reply: AskReply | undefined) }`, and `receive` branches on `kind` in one place, with `/exit` read as an exit by the ask branch as well. A closed question resolves with a named value, not a word the caller must reinterpret.
- Show the real target in the approval preview: the path a link resolves to, computed by the same check that runs before the question. The write uses that same resolved path.
- Make `editFile` read and write bytes, refuse a file that is not valid UTF-8, and refuse a `previous` that matches more than once, or print the line of the match in the preview.
- Give `resolveNewInside` a structured error that names the ancestor that is not a folder.
- Make `/tools` show the state the model gets: a tool is off when the switches or the active profile's whitelist leave it out, and a switch that the profile overrides says so.
- Gate `.vise/mcp.json` and `.vise/hooks.json` behind the per-repository consent record described under Security, and start the servers only after consent.
- Start each MCP server into the registry as it starts, so an interrupt during startup stops the ones already running, and show a tool name as external only when the registry offers it. Replace the `__` naming rule with the registry's answer: the composition root builds one `ToolSet` (the built-in names and the registry) and passes it to `runTool`, the backend, and the profile and settings loaders, in place of the global `toolNames` that `run-tool.ts` still reads and the `isExternalName` rule that `tools.ts`, `tool-lines.ts`, and `sessions.ts` read.
- Read an HTTP answer event by event and return at the event that answers the request, so an open stream does not hold the call (see Known Problems). Re-initialize the session when the server answers 404 to a request that carried a session id.
- Send the HTTP client's requests with `redirect: "error"`, so a redirect ends the call and the headers never leave for another address. Accept `http:` only for loopback hosts, or for a host the entry names with an explicit flag.
- Let an HTTP entry name an environment variable for each secret header (for example `"Authorization": { "env": "VISE_MCP_TOKEN" }`), so `.vise/mcp.json` and the page hold the name, not the value. Git-ignore `.vise/`, and send the page header names only.
- Move `McpSession` and the request time limit into `src/tools/mcp/session.ts`, which both clients import, so the HTTP client does not depend on the stdio client.
- Stop a server's read errors from going unhandled: `readLines` returns a result, and a failed read stops that server and records a problem.

#### Undo

- Make `/undo` all-or-nothing in intent. Stage each restore (write a temporary file beside each target), refuse the revert if any staged file cannot be made, and only then rename each into place. If a rename still fails part-way, the log records the bytes each file holds, drops the reverted turns, and says which files were restored, so the log always matches the disk.
- Bound the undo log by bytes (for example, 64 MB for the session). A turn outside the budget is dropped with its points, and `/undo` says those points are gone.
- Record a change in the undo log only when the file's bytes differ after the call (see the failed edit under Known Problems).
- Make `/undo` show the files it will restore before it runs, or let the page ask for confirmation, since it is a write the user did not preview.
- Count only turns with changes toward the points, or say in the reply that the chosen turn changed no file (see Known Problems).

#### Background jobs and processes

- Stop a job's whole process tree on kill and when the session ends, including children that outlive PowerShell. This needs a Windows Job Object set to kill its processes on close, because `taskkill /T` cannot reach an orphan. Release the pipes when the call returns.
- Make a job's shutdown and removal confirmed. A job that could not be stopped stays tracked, and the warning names it. A job leaves the registry only after it has ended, its output has been drained, and that output has been read.

#### Hooks, instructions, and profiles

- Make a profile switch say in the history which profile applies now, as a user message that states the change. The history is still only appended to.

#### Compaction and summaries

- Show the summary to the user and let them confirm it before it replaces the history. Mark it in the request as model-written context.

#### Commands and models

- Parse the model listing per entry and keep only the entries that match, so one malformed model cannot fail `/context`.
- Move the model search into `src/core/commands.ts` as a pure function over the listing (an id that contains the text, ignoring case, sorted by code unit rather than by locale), so `runModelCommand` only prints the result. Test the order and the case rule there.

#### Saved sessions

- Check a loaded session's history before applying it: every tool call answered by a tool message with its id, no tool message without its call, and roles that alternate. Refuse a file that fails, and name the first broken message.
- Write a saved session to a temporary file in the same folder and rename it over the old one, so a failed save leaves the previous file intact. The save line says when a file was replaced.

### Nonfunctional

#### Core boundary

- Move command interpretation into `src/core` as pure functions over `(state, line) -> (state, output)`, so the REPL is a thin driver. The line classifier is in `src/core/commands.ts`; the command state moves next.
- Move the context state into the core: it keeps the last reported prompt tokens, receives usage through the same state transition as text, and formats the context line from `(used, total)`. The context window becomes a value the core asks for through a port, cached for the session, so `/context` does not fetch the full model listing on every call. The core decides what `/context` prints when the lookup fails, and it prints the used count in that case.
- Move the profile transitions into `src/core/compaction.ts` as pure functions over `Conversation`: use (records the profile and its pending text), and clear. `runProfileCommand` then only parses the command, loads the text through the profile port, and prints. The same functions decide what a switch does to the earlier profile's text.
- Make the session a function of its inputs: the frontend creates the readline interface and passes it where needed, so tests can drive a session without touching real streams.

#### Types and results

- Give `Reply` a named options interface in `src/core/messages.ts` (messages, callbacks, tools, reasoning, thinking) instead of six positional parameters, so each caller names what it passes.
- Derive `StreamEvent` and `Usage` from the schemas with `z.infer`. Record real OpenRouter responses as test fixtures, so the schemas are checked against the service and not against the tests' own assumptions.
- Introduce a structured result type for command outcomes (success, usage error, unknown command) instead of ad-hoc strings, with errors that say what failed, where, why, and what the user can do.

#### Errors

- Give the model adapter a structured error type (`ModelError`, with kinds such as `http`, `stream`, `parse`, `truncated`), so each failure says what failed, where, why, and what to do.
- Remove the `(error as Error)` casts in `src/providers/openrouter.ts` and normalise thrown values there the way `compact` does (`error instanceof Error ? error : new Error(String(error))`).
- Bring every context-window lookup inside a boundary.

#### Providers

- **Give every error its provider's name.** Move `streamChat` and its response schemas into `src/providers/chat-stream.ts`. The caller passes the endpoint and the label (`OpenRouter`, or the server's name) in its options, so each message names the provider that failed. `openrouter.ts` and `llama-cpp.ts` then each keep only their own calls, and neither imports the other. `select-model.ts` takes the name from the provider, not the word OpenRouter.
- **Move the reading of `.vise/providers.json` into `src/tools/models/`**, beside `model-settings.ts`, and let `src/providers` take the parsed servers as a value.
- **Cache each server's context window for the session**, read once per server, so `/context` and the pre-message check do not fetch `/props` each time (see Performance).

#### Tools

- Keep each tool's definition in one place: a module per tool, registered in one array, instead of a branch in each of the five functions of `src/core/tools.ts` and the two of `run-tool.ts`.
- Put the shell behind a platform port. `run_powershell` and `folder-picker.ts` call `powershell.exe` directly, so both are Windows-only today, and both should take their process from the same port.
- Make the folder handover a single transition table: a request is refused with an error when no session is running, a session's end while a folder is pending starts the next session, and the dialog's result is handled only in the phase that opened it. Its spawn returns a `Result`, and the page is told when the dialog cannot open.
- Give `read_file` a byte cap. Read the file as a stream that stops at the cap, and state the cap in the result.
- Cap the number of entries a listing returns, and say in the result when it was cut short, so the model can ask for a smaller path.

#### Limits and output

- Add a maximum line length and control-character handling before echo, applied to input and to model output.
- Move the Markdown DOM builder out of `src/web/client/markdown.ts` into `src/web/client/render/markdown-dom.ts`, so the parser has no DOM and its tests run without a document, as the Structure section describes. Not `view.ts`: `view.ts` imports the viewer, and the viewer (`files/file-view.ts`) imports the builder, so a builder in `view.ts` would be a circular import.
- Render a `.md` file in the viewer from a version number the page keeps, not from `JSON.stringify` of the whole state (see Performance).
- Drop a `.md` path from the viewer's Source set when its tab closes (see Known Problems).
- Enlarge the Source and Rendered button to 24px or more, and give it a visible focus ring.
- Support tables, underscore emphasis, and images (an image as its alt text, with no address loaded), or record each as unsupported in the page's help text.
- Recognise heading levels four to six and stop a number followed by a period at the start of a paragraph from opening a list, or record the subset's limits in the page's help text.
- Escape or sanitize model replies and `error:` lines the same way as tool lines.
- Bound the history per request: apply the compaction trigger to the size of the request about to be sent, not the previous one. Set `max_tokens`.

#### Styling

- Keep the palette in one place. `style.css` defines the same fourteen colour variables three times: in `:root`, in the `prefers-color-scheme: dark` block, and in `:root[data-theme="dark"]`. Have `theme.ts` resolve System to `light` or `dark` from `matchMedia` (and follow its change event), so it always sets `data-theme`, and keep one dark block.
- Draw each focus ring inside the box of a chamfered control (for example `outline-offset: -4px` with `:focus-visible`), and give the light accent text that passes 4.5 to 1 (white on `#8a6a1c` is about 5 to 1).
- Make the chamfer list cover every bordered box, or none of them, and keep one divider style: the composer's top rule is 1px solid, while the other dividers are 3px double.

#### Tests and tooling

- Add tests with a junction to a `.`-prefixed folder, since a symbolic link needs a privilege on Windows, and one for a dangling junction.
- Move the session format tests into `src/core/sessions.test.ts`.
- Pin dev dependencies to specific versions, and declare `typescript` as a dev dependency so checks run on a clean install.
- Make `scripts/check-files-per-dir.ts` count untracked files too, for example from a directory walk that skips `node_modules` and `.git`.
- Add a formatter, and naming rules to the linter.

## Performance

These are the obvious concerns only. Measure with a profiler before optimizing.

- Each streamed text delta is written with a separate `write` call. Fine at interactive speed. Large replies would benefit from buffering output per chunk.
- Long lines from user input, model replies, and file reads are held whole in memory and in the history. Job output lines are cut at 8192 characters.
- Each job stream keeps its last 500 lines, each cut at 8192 characters, so its memory is bounded. A job keeps reading until its process ends, so a command that prints gigabytes runs for its full time. Finished jobs stay in the registry until they are read.
- `/context` and the check before each message both fetch the full model listing, one large response for one number (see Model cache). For a llama.cpp server, each context-window read and each model listing fetches `/props` again, with no cache, so the same cost applies there.
- Compaction resends the whole history once more, plus the summary request, which roughly doubles the tokens for that turn. It is rare, but a long session can hit it repeatedly.
- MCP startup is sequential. Each server's handshake and each `tools/list` page wait for an answer, up to 60 seconds each, before the next server starts and before the first prompt. Servers can start in parallel once startup has a progress line.
- The viewer compares its whole state with `JSON.stringify` on each update, which copies the text of the file (up to 1 MB) on every change, such as opening another tab. A `.md` file is also parsed and built as a whole DOM on each draw, including a switch between Source and Rendered. Neither is measured yet.
- `list_files` reads the whole tree to the depth before it caps the output, and `read_file` loads the whole file to return a range. Both are described under Cost and size limits in Known Problems; the cap limits the output, not the walk or the memory.
- **Prompt cache.** The guiding principle is to hit the provider's prompt cache as often as possible (N5, N6). `wireMessages` and `toWire` in `src/providers/openrouter.ts` put the marker on the last message of each request whatever its role, as a text part (a tool message's content included). Two shapes cannot carry it: an assistant message with tool calls and no text, and an empty text. The marker on a tool message has not yet been confirmed against OpenRouter by a live probe, so a provider that rejects it would fail the tool loop rather than miss the cache. A probe against OpenRouter with `anthropic/claude-haiku-5.5` showed 7,204 cached tokens on the second identical prefix with the marker, and 0 without it. That probe covered two identical requests. It has not covered the turn after a completed one, where the previous last message is sent as plain text, so the cross-turn case needs a probe with two real turns. Provider caches are short-lived (about five minutes on Anthropic models), so a longer pause loses the prefix. Each compaction writes one cache entry for the whole history plus the summary request. The app does not yet read `cache_read` and `cache_write` from `usage`, so the hit rate is assumed, not measured.
