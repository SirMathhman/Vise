# Vise Architecture

This document describes the target architecture. It is a reference for where the project should go, not a changelog.

## Definitions

- **Common**: the `packages/common` workspace: zod schemas, wire types, and pure helpers. No I/O; zod is its only runtime dependency.
- **Backend**: the `packages/backend` Bun server. It is the only code that holds secrets and the only code that talks to third-party APIs. An **upstream** is any external service it calls, such as OpenRouter.
- **Frontend**: the `packages/frontend` browser app. It renders data and never contacts third-party services directly.
- **Stream event**: a typed wire event in `common`: `delta`, `done`, `error`, or `approval`. Every reply ends with exactly one `done` or `error`, so a cut-off reply is never mistaken for a finished one. An `approval` waits for the user's answer.
- **System context**: instructions the backend adds to every upstream request: the project root and the chosen profile's text. Only the backend writes it. The wire request carries user and assistant turns, and a profile id.
- **Profile**: a note in the profile category. Its content is system instructions the user chose for a chat.
- **Reply context**: the facts one reply passes to every tool: the project root, `ModelSelf` (model id, name, window, reply reserve, budget left, tool names), and the subagent runner, which only the main reply has. The loop passes it whole and names no tool.
- **Note**: a named record: id, name, category, summary, and content. Names are unique ignoring case. Notes are stored outside the project, in `notes.json`.

## Definitions: Tools and Approval

- **Local tool**: a function the model may call that the backend runs itself, such as reading project files. Its schema is owned by the backend and its output is untrusted text. A tool that changes a file, runs a command, or overwrites or deletes a note never acts directly: it returns an approval, a title and body shown to the user plus an apply step, and the apply step runs only after the user approves. A file change re-checks the file first.
- **Decision**: the user's answer to an approval, `approve` or `reject`. It is a named union carried from the approval route to the tool loop, never a boolean; a wait that ends without an answer is `undefined`, a third state no boolean can express.
- **Sentinel**: an upstream value with a special meaning, such as a price of -1 for variable pricing. It maps to an explicit unknown in the wire type, never to arithmetic.
- **Compaction**: when a send would pass 80% of the model's window, the browser asks for a summary of the older conversation and keeps it with the most recent ten messages. The summary applies no change and is not kept as history.
- **Invariant**: API keys never leave the backend. Every deserialization, including upstream responses, streamed chunks, request bodies, and saved history, goes through a zod schema via `parseJson`. ESLint bans `JSON.parse` and bare `.json()` calls elsewhere.

## Definitions: Lifecycle

- **Session**: one conversation. It starts with its first turn and ends when the user starts a new conversation. A page reload does not end it, and no hook runs then.
- **Turn**: one chat request that allows tools. A summary request sends no tools and is not a turn.
- **Subagent**: a reply the model starts with `start_subagent`. It has the parent's model and tools except that it cannot start one. Only its final text returns to the parent. It runs inside the parent's turn and shares its budget.
- **Background job**: a command that is still running after its 30-second wait. It belongs to its session: it stops at its 10-minute limit or when the session ends. Its output is read through `check_command`, which changes nothing.
- **Hook**: a shell command the user sets in the Hooks tab for `beforeSession`, `afterSession`, `beforeTurn`, or `afterTurn`. The global command in `hooks.json` runs first, then the chosen profile's command in `profile-hooks.json`; a failing global command stops the rest. Hooks are user configuration, never model output. A failing before hook stops its step; a failing after hook is logged and never changes the reply.

## Structure

Dependency direction is one way: frontend and backend depend on common, never the reverse. Backend and frontend do not import each other.

- Backend layers, from outside in: HTTP routing, then handlers, then upstream clients, then pure mapping functions. Each layer depends only on layers inside it.
- Each upstream gets its own module (`openrouter.ts` style) that owns its URL, auth, timeouts, validation, and error mapping.
- The tool loop, which decides when a tool runs and when the reply stops, is its own module. It depends on the upstream client, the tool registry, and the approval registry; none of them depends on it.
- The reply context is built in `chat/` by a pure, unit-tested function that counts exactly what the upstream request will carry: system context, profile text, and tool definitions. The route looks up a profile through the notes module and passes its text in; it builds no system message.
- The approval registry in `approvals.ts` holds the replies waiting on a user answer. Only the tool loop opens an approval and only the approval route answers one. It is scoped to a single reply and lives no longer than that reply.
- Notes are a backend module, `notes/`, with the same layering: a store owns `notes.json` and returns results, and only the note routes and tools map those results to HTTP statuses or tool text. Route handlers live in the notes module, not in `index.ts`.

## Structure: Lifecycle

- Lifecycle is its own module, `hooks/`. It reads `hooks.json` and `profile-hooks.json` on each event, validates them with zod, and runs each command through Bash, on every platform. It depends on common, the process runner, the config location, and the notes module, which it uses only to confirm that a profile id names a profile note. No tool or upstream client depends on it.
- The Hooks tab is a frontend view. It edits both files through the hooks routes in `hooks/hooks-routes.ts`, which accept a profile only if it is a profile note. Profile commands are never stored in notes, so the note tools cannot read or write them.
- The chat route calls the hook module before the upstream call and when the reply stream ends. Session end has its own route.
- Hook processes, shell commands, and background jobs share one process runner in `process/`. It applies the time limit, the output cap, and the credential filter. It has two modes: captured, which waits for the result, and background, which returns a job id to read later. No second runner exists.

## Structure: Tools and Streaming

- Local tools are registered in `packages/backend/src/tools/index.ts`. Each has a zod argument schema and a description the Tools tab lists. A tool that runs processes lives in its own folder, `packages/backend/src/shell/`, and is registered beside the file tools; it depends only on common and the approval type. The sandbox module is the only path that starts a model-proposed command, and no tool runs a host process. The loop dispatches by registry lookup and names no tool. Every tool takes one input object (root, arguments, reply context), so no call passes arguments by position. All project file access, including the git-visible file list, path resolution, and the text checks, lives in `project-files.ts`, which the read, edit, and create tools share. No tool repeats the git, root, or link checks inline.
- Routing is a table of path to handler, not a growing `if` chain inside one `fetch` function.
- Frontend modules are split per view. Each view owns its DOM and calls a shared typed API client.
- All backend-to-frontend data passes through a typed client in common, so the wire contract is compiled, not assumed.
- Streaming: the upstream module parses the upstream body into stream events, and the HTTP layer frames them as server-sent events. Raw upstream bytes are never forwarded. The frontend consumes the same stream event types from common.
- Lint and typecheck are merge gates: `bun run lint` and `bun run typecheck` must pass under strict TypeScript rules.

## Structure: Subagents

A subagent is a nested run of the tool loop, started by the `start_subagent` tool through a runner the loop puts in the reply context. Only the main reply receives that runner, so nesting stops at one level, and the tool registry never imports the loop.

- The loop, not the tool, builds the subagent's request, with the parent's model, tools, and abort signal.
- The subagent's approvals reach the client through a relay the main reply drains while the tool runs.
- The loop cuts the subagent's final text to the command output cap, importing that limit from the process runner.
- A turn's subagents share a budget of 3 starts and 20 model calls. The main reply is not counted.

## Potential Problems

- Upstream outages stall the backend unless every request has a timeout. Only the wait for response headers is limited today.
- Upstream schema drift makes one odd field fail a whole chunk or model list, and the caller sees only a generic message.
- A parse failure is a structured `ParseError` with a field path. Callers match on its kind, and one bad streamed chunk still fails the whole reply rather than being skipped.
- Every page load hits the upstream, so rate limits and latency are shared by all users. Each turn re-sends the conversation. Near the limit, compaction spends one extra upstream call on a summary; the budget drops the oldest messages only after that, once a conversation passes the context window less 4,000 tokens reserved for the reply.
- A stream that fails after the first byte has already returned HTTP 200, so the status code cannot report the failure.
- The model's list call returns every note, and each note call reads the whole file. Neither has a size cap yet.
- A profile is read on every send, so editing it changes a conversation in progress without notice. A profile too large for the budget gets the message for a long conversation, which names the wrong fix: the profile must be shortened.
- A profile refusal is a plain string, not a `NoteError` kind, so the route cannot map it to a status by kind.

## Potential Problems: Tools and Commands

- Tool rounds sit outside the conversation budget, and each one re-sends the growing conversation. The round limit must stop the loop before it opens a request it will never read.
- A waiting approval ends after ten minutes or when the client disconnects, and its registry entry is then released. A backend restart still drops every pending approval.
- Tool output can mislead. A cut file's header still shows the whole line range, so a truncated read can look complete; the header must name the range actually returned. An edit matches exact text only, so a CRLF file cannot be edited, and a failed match is reported as text so the model can retry.
- Model facts are a snapshot. The budget figure is as it stood when the reply started, and each tool round adds to the conversation after it. The reply must say so rather than present the figure as live.
- Stopping a command kills the podman client and removes its container, so no container outlives its job. A backend restart runs no cleanup, so a container runs until its own limit. A stopped podman machine fails every command. Exit codes 124 and 125 can also come from the command itself, so the message can name the wrong cause.
- A background job outlives a stopped reply, since no abort reaches it. Jobs have no cap on how many run at once, and finished jobs stay readable until the session ends.

## Potential Problems: Subagents

- Subagent tokens are not counted in the turn's conversation budget. Each subagent call only has to fit the model's window.
- Each subagent's rounds are capped, but a subagent's running tool call is not stopped when the client leaves.

## Security Concerns

- **Trust boundary**: the backend trusts nothing from upstream or from the browser. Both are validated. It accepts browser requests only from the frontend dev origin, `http://localhost:5173`, never a wildcard. Every request that changes data must come from that origin with a JSON body, and the server listens on `127.0.0.1` only.
- **Key exposure**: the UI-saved upstream API key is stored in a per-user config file outside the project (`%APPDATA%\vise\openrouter.env`), or read from the environment, and is never returned in responses or logs. The UI sends it once, on save. No sandbox mount reaches that folder. The sandbox also masks the old `packages/backend/.env` path as defense in depth; a command that reads another secret file inside the project can still send it upstream as tool output.
- **Open proxy**: any client that can reach the backend can spend the operator's upstream quota. Missing control: authentication on proxy routes.

## Potential Problems: Lifecycle

- Session identity is inferred from the message count, so a first turn that fails before the upstream call repeats the before-session hook on retry.
- The after-turn hook runs from the stream's flush, which does not run when the client disconnects. An aborted turn gets no after-turn hook.
- A reload or closed tab loses the session without its after-session hook. Nothing records that the session ended.
- Hook errors are plain strings that include command output, and the browser receives them.
- Profile commands are keyed by profile id and kept after the note is deleted, so they outlive their profile. Saves read and rewrite the whole file, so two saves at once can drop one.

## Security Concerns: Hooks

- **Trust boundary**: hooks run on the host with the backend's privileges, outside the sandbox. The config folder is outside every tool's reach, so the model cannot write either file. Hooks are trusted user configuration, and the Hooks tab and its routes are the only writers.
- **Unauthenticated writes**: a write must come from the frontend origin with a JSON body, which stops other websites and plain form posts. A local program can still send that origin header and save commands the host will run. Missing control: a secret the frontend sends with each write.
- **Unauthenticated trigger**: `POST /api/session/end` runs the after-session hook, and its body names the profile whose command runs. The origin and JSON checks apply to it, but a local program can still send them. Missing control: the same secret as for writes.
- **Output**: hook error text, up to the runner's 20,000-character cap, reaches the browser and the log. Missing control: a smaller cap for error text.

## Security Concerns: Approvals and Commands

- **Approvals**: approval ids are random UUIDs, and the answer route accepts an answer from any caller holding one. Approval is the only gate on a file write or a command. Each wait ends after ten minutes or when the client disconnects. Missing control: authentication on the route. A subagent's approval card looks like the main reply's and does not name the subagent or its task. Missing control: the card names its origin and shows the task.
- **Command execution**: the model may propose any shell command. It runs only after the user approves the command text, inside a throwaway podman container from the sandbox image. Only the project is mounted, read-write at `/workspace`; no host environment reaches the container; capabilities are dropped; and the run has a time limit, and a background run also ends with its session. It never runs on the host and has no fallback. Missing controls: a network policy, since installs need the network; a digest-pinned image; CPU, memory, and process limits; and a block on writes to git-ignored files and the mounted `.git` directory, whose hooks run when git runs. Any secret the mount reaches can leave through the network or the output. Tool output and file text can carry instructions that steer which command the user is asked to approve.

## Security Concerns: Chat and Files

- **Chat input**: the backend enforces the conversation budget: the model's context window, less 4,000 tokens reserved for the reply. Before a send the backend can only estimate, at four characters per token; OpenRouter's usage count, which includes tool definitions, is shown in the meter after each reply. The backend rejects any client-supplied system role, so the client cannot set the model's instructions. The client still supplies the assistant turns, so it can forge prior context. Each request spends paid upstream tokens. A compaction summary is sent with an empty tool list, so it can read no files and propose no changes. The system role also carries a profile's text: the user picks the profile, but a model may have written its note (see Notes). Missing controls: a backend-side model allowlist and authentication.

## Security Concerns: Files and Local Data

- **Path disclosure and tool output**: the system context names the project root, and tool listings name project files. Both reach the upstream only, never the browser or local history. Tools skip git-ignored files. The reading tool sends the contents of any git-visible file upstream, so a tracked file holding a secret leaks it. The editing tool can rewrite any git-visible file, including files that run code when a developer runs the project, such as lint config, package scripts, and CI workflows. The creating tool refuses git's own directories, where a hook would run code on the next git command. Missing controls: a denylist for secret-like paths and for executable config, applied by one shared path check that read, edit, create, and command execution all use. Symbolic links are refused, and only a path on the git list can be read or edited. Tool output is untrusted text that can carry injected instructions. Missing control: a byte cap on tool output across all rounds.
- **Local history**: the conversation is stored in browser localStorage as plain text. Anyone with access to the browser profile can read it, so it must never hold keys.
- **Rendering**: model metadata is untrusted text. It must be set with `textContent`, never `innerHTML`.
- **Logging**: error messages must not echo upstream bodies or request headers.

## Security Concerns: Notes

- **Trust boundary**: a note's text can come from a model reply, a file, or a web page, so it is untrusted. Any injected instruction that reaches the model can call the note tools. Creating a note may run without approval. Overwriting or deleting one must go through an approval that shows the note's current and new fields, as file writes do.
- **Profiles**: a profile's text is system instructions, the most trusted text the model sees. The model may create a profile directly, like any note, so a planted profile can reach the picker. Missing control: user approval for creating a profile, and a check on its text.
- **Data exposure**: `list_notes` and `read_note` send note content upstream as tool output. A note holding a key or password therefore leaves the machine on every read. Missing control: a way to mark a note as never sent to the model.
- **Loss**: deletion is permanent. Missing control: a trash that keeps deleted notes for a set period, so an approved or mistaken delete can be undone.

## Future Work

- A structured error enum for all failures, not only parsing, answering what failed, where, why, and how to fix it, mapped to HTTP status codes in one place.
- Configuration loaded once at startup and validated, instead of read per request.
- Model facts that carry the time they were taken, so a reply can tell a stale budget from a fresh one.
- A response cache with a bounded TTL in front of the models upstream.
- Authentication on backend routes that proxy paid upstreams.
- Size rules in `eslint.config.mjs` for lines per file, lines per function, and complexity, each limit documented here. The entries-per-folder limit of 10 is enforced by `eslint-rules/folder-file-limit.mjs`.
- A repair path for an unreadable notes file, which every note call currently reports as a failure.
- Secrets kept outside the project root so the sandbox mount holds none, with the `.env` mask as defense in depth; a digest-pinned sandbox image; and a network policy that separates installs from test runs.
- Compaction as a pure, tested module in the frontend, outside the view. Its summary request runs without tools, and the summary is checked before it replaces history.
- A byte cap on tool output, counted in the conversation budget. Exact-match edits that accept CRLF files and keep their line endings. Tests for fragment merging, the file-listing helpers, and every refusal path of the reading tool: ignored, symbolic link, binary, oversized, and outside the root.

## Future Work: Lifecycle

- Backend-issued session ids, sent with each turn and end request, so start, end, and retry are exact.
- An after-turn hook that runs on every end of a turn, including an aborted one, from the route rather than the stream's flush.
- Hook failures as a structured error enum that names the event, the file, and the exit code, with the output capped.
- A time limit per hook, since every hook now shares the 30-second limit.
- Background jobs tied to the reply's abort signal and capped in number per session, so a stopped reply stops its command.
- Profile commands removed with their profile note.

## Performance

- Each chat request waits for the before-turn hook, so a slow hook adds latency to every send. Measure hook time apart from upstream time.
- Upstream calls without caching are the main latency risk, and streams have no timeout after the reply's headers arrive.
- The app is exactly the window size. The chat conversation is the only scroll region; every other section must fit the window or page its rows. Content clipped below the window is a defect, not a layout.
- Re-sending the conversation on every turn makes cost grow with its length, so the shared budget caps each request.
- Command output is read as it arrives and stops at 20,000 characters per stream, so the cap bounds memory.
- Each file tool call spawns git and rebuilds the file list, so one turn with several reads runs git several times. Cache the list per turn once a profile shows it matters.
- Note reads parse the whole notes file, and the list call sends every note upstream. Both grow with the number of notes.
- Nothing here has been profiled. Measure with a profiler before optimizing.
