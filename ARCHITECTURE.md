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
| **Profile** | A note in the `profile` category whose text is custom instructions for the model. |
| **Saved session** | A conversation written to `.vise/sessions/<name>.json` by `/save` and read back by `/load`. It holds the history, the active and pending profile, the pending hook output, the switched-off tools, the last prompt size, and the compacted flag. `/load` replaces the current conversation with it. The file is data from outside the run (see Security). |
| **Session** | One run of the REPL, from start until `/exit` or end of input. |
| **Subagent** | A conversation of its own, started by the model with `run_subagent`. |
| **Thinking** | The model's reasoning effort, set by `/thinking`. |
| **Tool** | An action the model may request by name, with arguments it writes as JSON. A tool that writes or runs anything must be approved by the user before it runs. |
| **Tool round** | One request to the model and the tool calls it asked for. |

## Invariants

Each invariant has a label (F1 to F5 for functional, N1 to N6 for nonfunctional). Other sections refer to them by label.

### Functional

#### Lines and the session

- **F1. Exit is final.** Once a session has ended, no line after the exit word produces output or side effects.
- **F2. One response per line.** Every line the frontend accepts produces one response, or none once the session has ended. A message line may produce several parts, in this order: the compaction notice (or its error), then a line for each tool call of each round, then the reply text. A failed round ends the turn with an error line, and the whole turn is removed from the history.

#### Commands

- **F3. Commands stay out of the model.** A `/` line is consumed by the core whether or not it is known. A command may make the core send the history to the model (`/compact` does), but never its own text.

#### Approval and end of input

- **F4. Approval comes from the user, after the preview.** A write or command the model requests runs only after an approval given after its preview was printed. The one exception is a command the user types (`/note new`, `/tools enable`, `/tools disable`): the user's own line is the decision, and no model text is involved. A line received before the preview is never an approval, and a question never leads to a request to the model once input has ended. Approval is enforced where the tool runs, not only by the loop that asks, so a second caller of the tool runner cannot skip it.
- **F5. No work after the end.** Once input has ended or a stream has failed, no further request is sent to the model, whatever the reply has asked for. The turn stops after the reply that was running, and no tool call in it runs once the session has ended.

### Nonfunctional

#### Core and I/O

- **N1. The core does no I/O, and the backend does it only through ports.** Only the frontend reads or writes streams. The backend reaches the network, disk, and processes through the ports the composition root passes in.
- **N2. Deterministic given its input.** Behaviour depends only on the input stream and the arguments passed in, so the same input gives the same output. The exceptions are the model adapter, the context-window lookup, and the compaction summary, whose replies come from the network. Each must return a complete reply or an error, never a silently truncated success. A failed or truncated summary leaves the history unchanged.

#### Streams and exit

- **N3. Streams are released before return.** On every exit path (end of input, `/exit`, a stream error, or a reply that throws), the readline interface is closed and the frontend's error listeners are removed, so the process can end without waiting for more input.
- **N4. Late stream errors are reported, not thrown.** A stream error that arrives after a session has returned is reported by the composition root with a readable message and exit code 1. It is never an uncaught exception with a stack trace. (Not yet met; see Known Problems.)

#### Prompt cache and tools

- **N5. The prompt prefix is append-only.** Between compactions the history changes only by appending: a user message, then assistant messages (with any tool calls) and tool messages. Compaction and `/load` are the only other changes, and each starts a new prefix, so the next request misses the cache once. A failed request, or a failed round, leaves no trace: the whole turn is removed, so the next request begins with the same messages as the last completed one. The cache breakpoint is a marker on the last message of each request, whatever its role. It never changes which messages are sent.
- **N6. Tool definitions are stable.** The tools are fixed in code, and the request carries the same tool definitions every time for as long as the user leaves the switches unchanged. Switches come from `/tools` or from a profile's `tools:` whitelist, and each changes the tools part of the prompt, so the next request misses the cache for the whole prefix. The user accepts that cost. `/tools` switches are saved to `.vise/tools.json` and read at startup. `/load` applies a saved session's switched-off tools for that session only, which is also a change to the tools part.

## Frontend and backend

The session is split into a backend, which owns the turn loop, conversation state, tool rounds, hooks, commands, subagents, and approvals, and a frontend, which owns the terminal. The two talk through a typed event protocol in `src/protocol/`, and only `index.ts` connects them. The terminal frontend is in-process. The browser frontend (`bun run web`, or `index.ts --web`) runs the same session and carries the same messages as JSON over a WebSocket on 127.0.0.1. The protocol is plain data with no functions, so either transport works without changing the backend.

- **Frontend to backend (`ClientMessage`):** `line` (one input line; a browser adds `shown`, the id of the newest approval question its page has displayed), `approval` (an answer to an `approvalRequest`, identified by its `id`), `inputEnded`, and `failed` (a stream error). The browser may send only `line` and `approval`. Its server parses every other kind as an error, so a closed tab never ends the session.
- **Backend to frontend (`ServerEvent`):** `text` (a reply chunk, raw and unsanitized), `replyEnd`, `thinking` and `thinkingDone`, `toolCall` and `toolSkipped`, `approvalRequest` (with `id` and `preview`), `approvalAnswered` (with `id` and `answer`, so a reconnecting frontend knows which questions are still open), `hookOutput` (the full text), `notice`, `error`, `ready`, and `ended`. The event stream ends after `ended`.

Decisions that keep F4 and F5 true across the split:

- **Approval (F4).** The backend's `approve` drops the lines queued before the question, emits `approvalRequest`, and waits. The answer is the next line the backend receives, read by `answerOfLine` in `src/core/commands.ts`, or an `approval` message with the question's `id`. A browser line carries `shown`; while a question is open, a line whose `shown` is not that question's id is not an answer. The backend drops it and sends a notice, because the user typed it before seeing the question. A line without `shown` (the terminal) is read as the answer, as before. A frontend keeps no approval state of its own: the browser page derives the open question from the events it has received (the last `approvalRequest` with no `approvalAnswered`), and uses it only to lock its composer. Enforcement stays in `runTool`.
- **No work after the end (F5).** The backend owns the inbox of lines. `finished()` is `exitRequested || streamError || !inbox.more`, so queued lines still count as input.
- **Presentation is the frontend's.** Sanitizing, the thinking line's redraw, the 4000-character display cap on hook output, and prompts are done by the frontend's renderer. The backend never writes escape sequences.
- **Command handlers** emit `notice` and `error` events and do not take a stream.

The dependency rules are in Dependency direction below.

## Behaviour

### Commands

The commands are `/exit`, `/context`, `/compact`, `/note`, `/profile`, `/tools`, `/thinking`, `/model`, `/save`, `/load`, `/sessions`, and `/help`. The core classifies any other `/` line as `unknown-command`, and the frontend reports it as an error.

- **`/exit`**: the core recognises a line whose trimmed text is `/exit`. After it, the session accepts no further lines, even ones that arrived in the same chunk of input. Bare words such as `exit` or `quit` are ordinary lines.
- **`/context`**: reports the prompt tokens the provider counted for the most recent request that reported usage, out of the model's context window. Both numbers come from the provider, not an estimate. Before any request has reported usage, it says no request has been sent. After a compaction, it says the size is unknown until the next request, because the counted size described the history that was replaced. It never says no request was sent when one was.
- **`/compact`**: runs a compaction now (see Compaction).
- **`/note new <category> <name>`** creates a note with its scaffold. **`/note list [category]`** lists notes. The core reads the words, and a note runner that the composition root passes in does the file work. A `/note` line never reaches the model.
- **`/profile`**: see Notes and profiles.
- **`/tools`** lists the tools and whether each is on. **`/tools enable|disable <tool>`** switches one. The switch applies from the next request and is saved to `.vise/tools.json`. A switched-off tool is left out of the request, and a call to it is refused without approval.
- **`/thinking off|low|medium|high`**: sets the thinking effort (see Thinking).
- **`/model`** shows the model in use. **`/model search <text>`** lists the models whose id contains the text, ignoring case, in alphabetical order. **`/model <name>`** switches to a listed model and keeps the conversation. The choice is saved to `.vise/model.json`.
- **`/help`** prints every command on its own line, with its usage and a one-line summary. **`/help <command>`** prints the usage and a fuller description of that command. The text is built in `src/core/commands.ts` from one table, and the backend emits it as a notice. An unknown name is an error. Like every command, it never reaches the model.
- **`/save <name>`** writes the conversation as a saved session, replacing one of the same name. **`/load <name>`** replaces the conversation with a saved session and applies that session's switched-off tools, for that session only; it does not write `.vise/tools.json`. **`/sessions`** lists the saved names.

### Notes and profiles

- A **note** is a Markdown file at `notes/<category>/<name>.md`. The name and category come from the path, and each may contain only letters, digits, `-`, and `_`. The file starts with a header of `name`, `category`, and `summary` lines between two `---` lines, then the body. Creating a note writes that scaffold and refuses an existing file. Reading and editing notes is done with the file tools, not by Vise.
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
  - `run_subagent` (starts a subagent; see Subagents).
- Of the nine tools, eight run in `src/tools/` through `runTool`, which dispatches by name and checks the target before asking. `run_subagent` is started by the REPL, not by `runTool`, because it runs a conversation rather than a single action.

### Approval

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

The text of `AGENTS.md` in the working directory is read once when the session starts. It is put in front of the first user message of the session, so it is the first thing the model sees. It is sent in every request until compaction removes it. A missing or blank file gives no instructions and no message. The composition root reads the file in `src/instructions.ts`, and the frontend receives only the text. The path and size are not shown to the user before the text is sent (see Security).

### Subagents

A subagent is started by the model with `run_subagent`, which takes a profile name, a task, and a `max_tool_calls` limit.

- It runs the turn-start hooks, then its profile's text and the task as its first message, then its own tool rounds.
- It is offered only the tools its profile lists, minus the tools the user has switched off with `/tools`. It is never offered `run_subagent` itself. A profile with no `tools:` line refuses a subagent.
- It makes at most `max_tool_calls` tool calls. At the limit it is asked once more with no tools, and its answer is marked as cut short.
- Its writes and commands ask the user through the same approval queue as the main conversation, one question at a time.
- Several subagents asked for in one reply run together, and the calls of that reply wait for them.
- Only its final answer returns to the main conversation, as the tool result. Its history is not kept, saved, or added to the main history.
- It runs the turn-end hooks, and the global and profile hooks, in the same order as a turn.
- Its loop is started by the backend (`src/backend/subagent/subagent.ts`), not by `runTool`. It is a second tool-round loop beside the turn (see Known Problems).

### Saved sessions

A saved session holds the fields listed under Definitions. `/load` puts its history into the next request with the user's authority, so the file is checked before it is applied (see Security and Known Problems).

## Structure

Target layout. Test files sit beside the module each one tests; there is no separate tests folder.

```
└── vise/
    ├── index.ts                         composition root: wires stdin, stdout, and OPENROUTER_API_KEY to the REPL or, with --web, to the browser server; reads the tools and model settings at startup
    ├── scripts/                         build checks run by bun run lint, and the web:dev development script
    │   ├── check-files-per-dir.ts       file count per directory
    │   └── web-dev.ts                   bun run web:dev: runs the browser server and restarts it when a file under src/ or index.ts changes
    └── src/
        ├── instructions.ts              reads AGENTS.md from the working directory (the one file read at startup)
        ├── openrouter.ts                model adapter: streams chat completions over HTTPS, the only network code
        ├── core/                        pure logic; imports nothing from node: except types
        │   ├── commands.ts              line classification, command parsing, and the /help table (usage and description of each command)
        │   ├── compaction.ts            Conversation state: summary request, compacted history, 80% check, profile use and clear
        │   ├── messages.ts              shared data types and model ports (ChatMessage, ToolCall, Usage, ReplyRequest, Reply, ContextWindow)
        │   ├── notes.ts                 note rules: name checks, path and scaffold, header parser, /note and /profile words, NoteRunner and ProfileLoader ports
        │   ├── result.ts                Result type: ok and err for returned failures
        │   ├── sessions.ts              saved-session format (encode; decode with shape and pairing checks), /save, /load, /sessions words, SessionStore port
        │   └── tools.ts                 tool specs, argument parsing, /tools words, approval rule, call line, Approve and ToolRunner ports
        ├── protocol/                    the frontend-backend contract (types only, plain data)
        │   ├── protocol.ts              ClientMessage, ServerEvent, Session
        │   └── channel.ts               Channel<T>: the async queue the backend's inbox is built on
        ├── backend/                     session engine: no terminal, no readline
        │   ├── session.ts               startSession: session loop, line inbox, approval questions, sessionStart and sessionEnd hooks
        │   ├── turn.ts                  runMessageTurn and streamRound: the turn's tool rounds and hooks
        │   ├── calls.ts                 runCalls: one round's calls, and subagent calls
        │   ├── ports.ts                 SessionPorts: every port the backend uses
        │   ├── subagent/                runSubagent and queueApprovals
        │   └── commands/                command handlers, which emit notices and errors
        ├── repl/                        terminal frontend: readline and rendering
        │   ├── repl.ts                  runRepl: sends lines, prints events, prompts on ready
        │   ├── render.ts                ServerEvent to terminal text: sanitizing, thinking line, hook display cap
        │   └── session-helper.ts        test helper: runWithPorts and echoReply
        ├── web/                         browser frontend: a WebSocket relay and a page in plain TypeScript, with no framework
        │   ├── server/
        │   │   ├── server.ts            startWebServer: listens on 127.0.0.1, checks the token and Origin on the socket, serves the page
        │   │   ├── hub.ts               keeps every event for replay; one viewer at a time (a new tab takes over the session)
        │   │   ├── client-message.ts    reads the browser's messages: lines and approvals only
        │   │   └── page.ts              bundles the page script at startup
        │   └── client/
        │       ├── main.ts              the socket, reconnects, render schedule (side effects only)
        │       ├── state.ts             pure reducer: server events to the transcript
        │       └── view.ts              DOM from the state, text set with textContent only
        └── tools/                       disk, process, and settings work for the tools and the frontend
            ├── run-tool.ts              dispatches a call by name, checks the target before asking, runs a change only when approve resolves true
            ├── run-powershell.ts        the only process spawning; a command still running after 30 seconds becomes a background job
            ├── jobs.ts                  background jobs: last 500 lines per stream, reads, stops process trees, stops all at exit (at most 5 running)
            ├── tool-settings.ts         .vise/tools.json: readToolSettings (at startup) and saveToolSettings (via /tools)
            ├── session-store.ts         .vise/sessions/<name>.json: reads and writes
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
                └── run-note-command.ts  the function the REPL calls for a /note line
```

### Dependency direction

```
index.ts  ->  src/repl  ->  src/protocol  ->  src/core (types)
index.ts  ->  src/web/server  ->  src/protocol, src/core
src/web/client  ->  src/protocol (types)
index.ts  ->  src/backend  ->  src/protocol, src/core
index.ts  ->  src/openrouter.ts  ->  src/core
index.ts  ->  src/tools  ->  src/core
```

`src/core` imports nothing from `src/repl`, `src/backend`, `src/protocol`, `src/tools`, `src/openrouter.ts`, or `index.ts`. `src/protocol` imports only core types. `src/repl` imports `src/protocol` and core types only, and never `src/backend`, `src/tools`, or `src/openrouter.ts`. `src/backend` imports `src/protocol` and `src/core`, and reaches disk, processes, and the network only through ports. `src/tools` and `src/openrouter.ts` may import `src/core`, never the reverse, and they do not import each other. Only `index.ts` imports both the frontend and the backend. `src/web/server` follows the rules of `src/repl`, and `src/web/client` may import protocol types only, as type-only imports; it is built for the browser and never runs under Bun. The client is checked with its own tsconfig (`src/web/client/tsconfig.json`), because the browser types are not part of the rest of the project. Tests and the test helper `src/repl/session-helper.ts` may import any module. There are no circular imports.

Recursion is avoided in core. When a function would need to call a function that calls it back, pass the callback as a parameter instead of importing across files.

### Code rules

These are enforced by `bun run lint` as errors (ESLint for the line, function, and type rules, `scripts/check-files-per-dir.ts` for the file count):

- at most 100 code lines per function (`max-lines-per-function`);
- at most 4 parameters per function (`max-params`). A function that needs more takes one parameter object, declared as an interface;
- at most 500 code lines per file (`max-lines`);
- at most 10 tracked files per directory;
- no object type literals written inline as `{ ... }` (`TSTypeLiteral`). Declare a named interface instead;
- no function-typed fields in an interface (`TSPropertySignature` whose type is a function type). Declare a method signature instead, such as `reply(request: ReplyRequest): ...`. Callers keep the same `obj.name(...)` syntax. A field typed by a function alias (`approve: Approve`) is not caught by the rule, so it is kept by convention;
- no `throw` statements (`ThrowStatement`). Failures are returned as a `Result` from `src/core/result.ts`.

Each source file has one responsibility. Entry points contain wiring only: they read the environment, construct the functions, and call exported functions. Test files live next to what they test.

## Known Problems

Each item is a known defect or gap. Fixes are listed under Future Work.

### Functional

#### Input and the session

- **The browser page has no caps.** Hook output is shown in full (the terminal caps it at 4000 characters), a typed line has no length limit, and the hub keeps every event for the life of the process and replays all of them on each connection, so memory and reconnect time grow with the session.
- **Retired exit words reach the model.** `exit` and `quit` are no longer commands, so a user who types them from habit sends them to OpenRouter as a message, which spends a request. The frontend should say which command ends the session.
- **Approval discards queued input silently.** When the preview is printed, the backend's `Channel.discard()` drops every line queued before the question, as F4 requires. The drop is silent. With piped or pasted input, every line arrives at once, so an answer sent with the command is discarded and the command is refused with no message (verified: `a` then `y` piped in one chunk refused the call and dropped `y`).
- **The tool loop continues while queued input remains.** `finished()` stops the loop on a stream error, on `/exit`, or when input has ended and the queue is empty. A queued line keeps the loop going. Input `a` and `b` piped together, with a reply that asks for `list_files`, ran the tool and sent two more requests after the input had ended (verified: three requests in all). Decision: queued lines still count as input to answer, so a piped message followed by `/exit` keeps its tool result. This is accepted, not a defect, but it does not meet F5 as written. A skipped call is answered with a tool message that says it did not run, so every call in the history has a result.

#### Errors and exit

- **Stream errors are reported late.** `runRepl` listens for `error` on input and output, and on the readline interface. It aborts the interface and returns `err`, which `index.ts` prints before exiting with code 1. The abort does not reach the reply, so an error during a model stream is reported only after the stream ends or fails.
- **A stream error after the session has returned is uncaught.** The `finally` removes the frontend's error listeners, so an `error` emitted after `runRepl` returns has no listener. Bun then exits with status 1 and prints a stack trace (verified). The process ends and the failure is not lost, but it is not reported as a session failure (N4).
- **Thrown values are not always normalised.** `runRepl` turns a thrown reply error into a failure for that turn. The catch assumes the thrown value is an `Error`, so a thrown string prints `error: undefined` (verified). `compact` and the REPL's catch normalise the thrown value, but `src/openrouter.ts` still casts `(error as Error).message` in its three catch blocks. The `ContextWindow` calls in `showContext` and `compactIfNeeded` sit outside that boundary, so a throwing lookup rejects `runRepl` instead of returning an error.

#### Turns and output

- **Tool lines appear late.** A call's line is printed after the reply has ended, because the call is complete only when the stream finishes. A long reply therefore appears before the call that caused it.
- **Partial replies stay on screen.** When a model stream fails, `streamChat` yields an `err` result, and `runRepl` drops the user line from the history, so no truncated answer is recorded. The text already printed is not marked as incomplete, and nothing tells the user it was discarded.

#### Context and compaction

- **The stored prompt size is set only by completed requests.** A completed request records its size and clears the compacted flag. A compaction clears the size, so `/context` reports it as unknown rather than "no request sent yet". A failed request does not record its size. A failed compaction keeps the conversation unchanged, so the next message tries again. The automatic check uses the size of the previous request, not the request about to be sent, so a message that adds many tokens can overflow the window before the next check.
- **`/context` may not match the last line.** The count is from the last request that reported usage. A later request that failed is removed from the history, but the earlier count stays, and the output does not say which request it belongs to.
- **Compaction keeps roles alternating by merging.** When the first kept message is a user message, the summary is merged into it. If the first kept message is an assistant message, the summary stands alone as a user message. Either way the roles alternate.
- **The summary is invisible.** Summary chunks are collected without being written. The user never sees what the model kept, and the "history compacted" line does not say what was dropped. Everything older than the last six messages is gone from the session with no record shown.

#### Models and reasoning

- **Reasoning is not kept in the history.** `AssistantMessage` has no field for reasoning, and `toWire` sends an assistant message with only its text and tool calls. The stream's `reasoning_details` are read for the thinking count and then dropped. The provider expects the reasoning of a tool-calling message to come back unchanged, so with `/thinking` on, the second round of a tool loop may fail. This is unverified and needs a live probe with a tool call.
- **No timeout and no cancellation.** A request that never completes leaves the prompt blocked, with no way to abort it.

#### Tools and approval

- **A request with no tools field is unverified.** With no tools switched on, `streamChat` omits `tools`. A history that already holds tool calls and results may then be sent without tool definitions. Whether OpenRouter accepts that has not been checked. A profile's `tools:` whitelist reaches the same case: a history with calls to tools the profile does not allow is sent with those tools left out.
- **`/tools` ignores a profile's whitelist.** `toolStates` prints each tool as on or off from the switches alone, and `runToolsCommand` passes it only `disabledTools`. A tool the active profile does not allow shows `on`, and `/tools enable` reports it on while it is still not offered.
- **`edit_file` rewrites bytes outside the edit.** `editFile` reads the file as UTF-8 and writes it back as UTF-8, so any byte that is not valid UTF-8 becomes U+FFFD in the whole file (verified: `61 ff 0a 62` edited to `c` gave `61 ef bf bd 0a 63`).
- **The approval preview hides what will change.** It prints `previous` and `replacement`, not the line of the first match, nor how many matches there are. The write replaces the first match at the time of the write, so a file changed during the question can put the first match somewhere the user did not see. The preview also shows the path as typed, not the real location a link resolves to.
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

#### Hooks, instructions, and profiles

- **Instructions errors are hidden.** `readInstructions` returns undefined for every read error, so a permission error or an `AGENTS.md` that is a folder is treated as no file, with no message. The frontend also merges the instructions into the first user message, so the frontend decides what is sent.
- **A timed-out hook is not stopped.** Every point's output is printed, sanitized, cut at 4000 characters, and queued for the next message. A `sessionEnd` output is printed but never sent, since the session has closed, and a `turnEnd` output queued just before `/exit` is printed and not sent. A hook still running after 30 seconds is reported as failed, but its process keeps running as a background job that takes one of the five job slots and whose output nobody reads. A line containing the `[exit code N]` or `[still running` marker can be mistaken for the runner's own marker.
- **Profile switches stack.** A switch appends the new profile's text, and the earlier text stays in the history. `/profile default` does not remove it either. Until compaction, the model sees both profiles as user text, and both are in effect. The switch does not say which profile now applies.
- **Profile transitions are in the frontend.** `runProfileCommand` in `src/repl/repl.ts` builds the new `Conversation` for use and clear, the same kind of transition as `compact`. The failed-turn restore of `pendingProfile` has no test.
- **An empty `tools:` line offers no tool.** `parseHeader` reads a `tools:` line with no names as an empty list, and `enabledTools` allows nothing for it. The profile blocks every tool with no message (verified).

#### Commands and model search

- **The model search rule lives in the frontend, and its order depends on the locale.** `runModelCommand` in `src/backend/commands/commands.ts` filters and sorts the listing. The sort uses `localeCompare`, so `["Ab", "aa"]` sorts as `aa, Ab` in one locale and `Ab, aa` under the default sort (verified). No test pins the printed order; the `/model search` test checks only which models match.

#### Saved sessions and settings

- **A saved session can hold a history the provider rejects.** `decodeSession` checks the shape of each field and the tool names, but not the pairing of tool calls with results, nor the role order a live turn keeps. A hand-edited file can load a history that every later request rejects, and `/compact` sends it too.
- **A saved session without a tools field loads with every tool on.** `disabledTools` is optional in the file, so an older or hand-edited file re-enables any tool the user had switched off, with no message.
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
- **Directories are at or near the file limit.** `src/core` and the repository root hold ten tracked files each, the limit, so the next file in either must merge with another or move into a folder. `src/tools` holds nine at its top level.
- **The settings folder is not ignored.** `/tools` writes `.vise/tools.json` and `/model` writes `.vise/model.json`, and `.gitignore` does not list `.vise`. The files show as untracked and could be committed with the user's switches.
- **No formatter is configured.** The linter enforces size and correctness rules, not formatting.

#### Architecture

- **Tool definitions are spread across modules.** `src/core/tools.ts` (about 490 of 500 code lines) and `runTool`'s dispatch each add a branch per tool: the spec, the argument parser, the approval preview, and the call line in `tools.ts`, then the target check and the dispatch in `run-tool.ts`. The same file also holds the `/tools` words, the terminal `sanitize` helper, and the approval rule. Roughly three more tools would breach its file limit.
- **The turn loop is written twice.** `collectRound` in `src/backend/subagent/subagent.ts` repeats `streamRound` in `src/backend/turn.ts`. The subagent's tool-call loop repeats the round loop of `runMessageTurn`, with its own limit and its own history handling. A fix to one (a failed round, a finished session, a summary line) must be made to both.

#### Responses and schemas

- **Response schemas can drift from OpenRouter.** The zod schemas in `src/openrouter.ts` are hand-written, and the test fixtures come from the same assumptions, so a change on OpenRouter's side passes the tests and fails only at run time. `choices` and `usage` are `optional`, not nullable, so a `null` there fails the whole stream. `ModelListingSchema` requires every entry of `data` to match, so one model with a `null` `context_length` makes `/context` fail for every model. The error text from zod is printed verbatim. The schemas and the hand-declared types (`StreamEvent`, `Usage`) are two sources of truth. The error does not say which request failed.

#### Cost and size limits

- **Tool rounds are unbounded, and each is a paid request.** Nothing limits the rounds, the calls per round, or the total output. This is accepted by the user, but the cost and time must be visible as they happen, and a looping model must be stoppable with Ctrl+C.
- **The history is not bounded.** Compaction runs on `/compact` and before a message once the last prompt reached 80% of the window. Between compactions the history is resent in full, and no `max_tokens` is set, so one reply is unbounded.
- **`list_files` output has no size limit.** A listing returns every file name up to the depth, with no cap on the count, and includes large folders such as `node_modules`. The whole listing becomes one tool message, sent in every later request until compaction removes it.
- **`read_file` reads the whole file before the range is cut.** `readFileLines` loads the file, splits it, and only then applies the 500-line cap. The cap counts lines, not bytes, so 500 lines of 1 MB each come back whole and enter the history.

#### Model cache

- **`/thinking` may cost a cache miss.** `/thinking` sets a request field and does not touch the messages. A change to the thinking configuration can still invalidate the cached prefix, as a change to the tools does (N6). The user is not told this. Not yet verified against OpenRouter.
- **A model switch carries the old model's reasoning and misses the cache.** `/model <name>` keeps the history, so the reasoning items the previous model returned are sent to the new model with the next request. Whether OpenRouter rejects another model's reasoning is unverified. The first request after the switch also misses the cache, and the switch line does not say so.

## Security

### Trust boundary

Everything read from stdin, or sent over the browser socket, is untrusted text, and every line is sent to OpenRouter, a third party. The model's reply is also untrusted text. Vise reads file names and file contents under the working directory for `list_files` and `read_file` (hidden entries are skipped, and paths are checked on their real location). It writes files only through `edit_file`, `create_file`, and `create_note`, after the user approves each change on the terminal. `create_file` and `create_note` never overwrite. The writes without an approval are the ones the user types: `/note new` writes a note, and `/tools enable` or `/tools disable` writes `.vise/tools.json`. Neither takes model text. Vise starts PowerShell only through `run_powershell`, after the user approves each command. The command runs in the working directory. A command still running after 30 seconds becomes a background job that runs until the user approves `kill_command` for it or Vise exits, and its output is kept as its last 500 lines per stream. A child that outlives PowerShell is not stopped by `kill_command` (see Known Problems). The API key comes from `.env` and must never be echoed or logged.

### Trust in files and settings

- **Subagents act with the user's permissions.** A subagent's writes and commands go through the same approval queue as the main conversation. A subagent's profile can list commands in its hooks, which run without approval as described under Hooks, so a subagent run by a profile from a cloned repository inherits that trust.
- **Hooks run commands without approval.** `.vise/hooks.json` is trusted: any command in it runs with the user's permissions at the four hook points. A repository that ships this file runs its commands when a user starts Vise there. This is a standing approval given by a file, not by a command. `.vise` is not git-ignored, so the file can arrive in a clone.
- **Hook output reaches the model.** A hook's output is sent with the next user message, so a hook that prints file contents or secrets sends them to OpenRouter. The printed output is capped at 4000 characters. Whether the cap also applies to the text sent is not clear from the code, and it needs checking (see Known Problems).
- **Saved sessions are read from disk.** `/load` reads `.vise/sessions/<name>.json`, which the user wrote with `/save` or which came from elsewhere. A loaded file puts its history into the next request with the user's authority, sets the pending profile text, and sets the switched-off tools. Only field types and tool names are checked. Missing controls: a structure check of the history, a summary (message count, profile name, switched-off tools) shown before applying, and framing as saved context rather than the user's words.
- **Profile text.** A profile's text is sent as user text, with the user's authority, each time it is switched in and after each compaction. It may come from a file the user did not write (a cloned repository), or from model-written text the user approved. `/profile` shows only the name, not the text or its size. The loader confines reads to the working directory, and the text is captured at the switch. Missing controls: showing the text and size on the switch, capping the size with a defined response, and framing the text as profile-supplied.
- **Project instructions file.** `AGENTS.md` is read from the working directory, which may be a repository the user did not write. Its text is sent to OpenRouter at session start without the user typing it, and it carries the user's authority in every request. Missing controls: showing the path and size and asking before the first request, capping the size, and framing the text as project-supplied.

### Controls

Status is **missing**, **partial**, or in place.

#### Input and model output

- **Browser output (in place).** The page sets model text, tool lines, previews, and errors with `textContent` only, never as HTML, so model output cannot run as markup in the page.
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
- **Unauthenticated spending (partly addressed).** Any process that can write to the REPL's stdin spends the user's OpenRouter credit, and the terminal frontend has no check beyond that. The browser frontend listens on 127.0.0.1 only, and accepts its socket only with a random token printed once in the URL (sent in the fragment, so it is not sent to the server as part of the page address) and only from its own origin. So another web page cannot drive the session, but any local process that can read the URL can. No rate or spend limit exists.
- **Secrets (missing).** Vise must never log input lines to a file by default, since users may paste secrets. No logging exists yet. A saved session holds every line typed in plain text, including any pasted secret, and `/save` does not say where the file is.

## Future Work

### Functional

#### Turns and requests

- Bound the tool loop with a user-visible limit and a way to stop it (Ctrl+C through the `AbortSignal` below). The user chose no limit today; the architecture should still make the stop possible.
- Thread an `AbortSignal` from the frontend through the reply function into `fetch`.
- Print each tool line when the stream signals that the call is complete (its `finish_reason` chunk), not after the whole reply. Sanitize the call's name and path with the same control as model text.
- Keep the reasoning items of a tool-calling assistant message in the history, verbatim, and send them back in later requests with thinking on. Probe the provider with a tool round first.

#### Input and the session

- Announce, when a question discards queued lines, how many were dropped.
- Give the turn loop one explicit session-ended state, set when input ends (the readline `close` event), on a stream error, or at `/exit` during a question. Check it before every request and before every tool call. Queued lines still count as input to answer, so the check reads the queue rather than a separate flag. Only the queue-empty case stops the loop.

#### Errors and exit

- Handle late stream errors (N4): `runRepl` accepts an `onLateError` callback from the composition root, and the frontend keeps a listener on input and output after the session ends that forwards to it. `index.ts` prints the error and exits 1.
- Make the shutdown report run on every exit path of `index.ts`, not only when `runRepl` returns: a `try`/`finally` around the REPL, plus a handler for interrupts.

#### Tools and approval

- Show the real target in the approval preview: the path a link resolves to, computed by the same check that runs before the question. The write uses that same resolved path.
- Make `editFile` read and write bytes, refuse a file that is not valid UTF-8, and refuse a `previous` that matches more than once, or print the line of the match in the preview.
- Give `resolveNewInside` a structured error that names the ancestor that is not a folder.
- Make `/tools` show the state the model gets: a tool is off when the switches or the active profile's whitelist leave it out, and a switch that the profile overrides says so.

#### Background jobs and processes

- Stop a job's whole process tree on kill and when the session ends, including children that outlive PowerShell. This needs a Windows Job Object set to kill its processes on close, because `taskkill /T` cannot reach an orphan. Release the pipes when the call returns.
- Make a job's shutdown and removal confirmed. A job that could not be stopped stays tracked, and the warning names it. A job leaves the registry only after it has ended, its output has been drained, and that output has been read.

#### Hooks, instructions, and profiles

- Make a profile switch say in the history which profile applies now, as a user message that states the change. The history is still only appended to.
- Send the instructions as a system message built by the model adapter from the text the composition root passes it, not as part of the first user message. The frontend then composes no message content, and `/compact` keeps the instructions.

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
- Remove the `(error as Error)` casts in `src/openrouter.ts` and normalise thrown values there the way `compact` does (`error instanceof Error ? error : new Error(String(error))`).
- Bring every context-window lookup inside a boundary.

#### Tools

- Keep each tool's definition in one place: a module per tool, registered in one array, instead of a branch in each of the five functions of `src/core/tools.ts` and the two of `run-tool.ts`.
- Put the shell behind a platform port. `run_powershell` calls `powershell.exe` directly, so it is Windows-only today.
- Give `read_file` a byte cap. Read the file as a stream that stops at the cap, and state the cap in the result.
- Cap the number of entries a listing returns, and say in the result when it was cut short, so the model can ask for a smaller path.

#### Limits and output

- Add a maximum line length and control-character handling before echo, applied to input and to model output.
- Escape or sanitize model replies and `error:` lines the same way as tool lines.
- Bound the history per request: apply the compaction trigger to the size of the request about to be sent, not the previous one. Set `max_tokens`.
- Cache the context window for the session, so the check before each message does not fetch the model listing.

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
- `/context` fetches the full model listing on every call, a large response for one number. The same lookup runs before every message once a size is stored. Cache the context window for the session.
- Compaction resends the whole history once more, plus the summary request, which roughly doubles the tokens for that turn. It is rare, but a long session can hit it repeatedly.
- `list_files` reads every directory down to the depth before it returns, and holds every name in memory. A large tree at depth 5 is read in full even when the result is capped, so the cap limits the output, not the walk.
- `read_file` holds the whole file in memory to return a range of it, so a large file costs its full size even when the range is short.
- **Prompt cache.** The guiding principle is to hit the provider's prompt cache as often as possible (N5, N6). `wireMessages` and `toWire` in `src/openrouter.ts` put the marker only on a user or assistant message without tool calls. A tool message, or an assistant message with tool calls, is sent without a marker. Each round of a tool loop ends with a tool message, so the requests made during a tool loop have no breakpoint and write no cache entry. The next turn then reuses only the prefix written by the last text reply. The fix is to attach the marker to the last message whatever its shape, for example by sending a tool message's content as a text part with `cache_control`, and to confirm with a probe that the provider accepts it. A probe against OpenRouter with `anthropic/claude-haiku-5.5` showed 7,204 cached tokens on the second identical prefix with the marker, and 0 without it. That probe covered two identical requests. It has not covered the turn after a completed one, where the previous last message is sent as plain text, so the cross-turn case needs a probe with two real turns. Provider caches are short-lived (about five minutes on Anthropic models), so a longer pause loses the prefix. Each compaction writes one cache entry for the whole history plus the summary request. The app does not yet read `cache_read` and `cache_write` from `usage`, so the hit rate is assumed, not measured.
