# Vise Architecture

This document describes the target architecture. It is a reference for where the project should go, not a changelog.

## Definitions: Packages

- **Common**: the `packages/common` workspace. Holds the zod schemas and wire types (JSON exchanged between frontend and backend), plus pure helpers. It has no I/O; zod is its only runtime dependency.

## Definitions: Backend

- **Backend**: the `packages/backend` Bun server. It is the only code that holds secrets and the only code that talks to third-party APIs. An **upstream** is any external service it calls, such as OpenRouter.

## Definitions: Frontend

- **Frontend**: the `packages/frontend` browser app. It renders data and never contacts third-party services directly.

## Definitions: Stream events

- **Stream event**: a typed wire event in `common`: `delta`, `done`, `error`, or `approval`. Every streamed reply ends with exactly one `done` or `error`, so a cut-off reply is never mistaken for a finished one.

## Definitions: Approval events

- An `approval` is not an ending: the reply waits until the user answers it.

## Definitions: System context

- **System context**: instructions the backend adds to every upstream request, such as the project root. Only the backend writes it. The wire request carries user and assistant turns only.

## Definitions: Local tools

- **Local tool**: a function the model may call that the backend runs itself, such as listing or reading project files. Its schema is owned by the backend and its output is untrusted text.

## Definitions: Tool approval

- A tool that changes a file or runs a command never acts directly: it returns an approval, a title and body shown to the user plus an apply step, and the apply step runs only after the user approves.

## Definitions: File re-check

- A file change also re-checks the file first.

## Definitions: Decision

- **Decision**: the user's answer to an approval, `approve` or `reject`. It is a named union carried from the approval route to the tool loop, never a boolean; a wait that ends without an answer is `undefined`, a third state no boolean can express.

## Definitions: Sentinel

- **Sentinel**: an upstream value with a special meaning, such as a price of -1 for variable pricing. It maps to an explicit unknown in the wire type, never to arithmetic.

## Definitions: Compaction

- **Compaction**: when a send would pass 80% of the model's window, the browser asks the model for a summary of the older conversation, then keeps the summary and the most recent ten messages.

## Definitions: Summary turn

- The summary turn never applies a change and is not kept as history.

## Definitions: Invariant

- **Invariant**: API keys never leave the backend. Every deserialization, including upstream responses, streamed chunks, request bodies, and saved history, goes through a zod schema via `parseJson`.

## Definitions: Parsing rule

- ESLint bans `JSON.parse` and bare `.json()` calls elsewhere.

## Structure: Dependencies

Dependency direction is one way: frontend and backend depend on common, never the reverse. Backend and frontend do not import each other.

## Structure: Backend layers

- Backend layers, from outside in: HTTP routing, then handlers, then upstream clients, then pure mapping functions. Each layer depends only on layers inside it.

## Structure: Upstream modules

- Each upstream gets its own module (`openrouter.ts` style) that owns its URL, auth, timeouts, validation, and error mapping.

## Structure: Tool loop

- The tool loop, which decides when a tool runs and when the reply stops, is its own module. It depends on the upstream client, the tool registry, and the approval registry; none of them depends on it.

## Structure: Approval registry

- The approval registry in `approvals.ts` holds the replies waiting on a user answer. Only the tool loop opens an approval and only the approval route answers one.

## Structure: Approval scope

- It is scoped to a single reply and lives no longer than that reply.

## Structure: Local tools

- Local tools are registered in `packages/backend/src/tools/index.ts`. Each has a zod argument schema. Tools receive the project root as a parameter.

## Structure: Process tools

- A tool that runs processes lives in its own folder, `packages/backend/src/shell/`, and is registered beside the file tools; it depends only on common and the approval type.

## Structure: Command sandbox

- The sandbox module is the only path that starts a model-proposed command, and no host runner exists.

## Structure: Tool dispatch

- The loop dispatches by registry lookup and names no tool.

## Structure: Project file access

- All project file access, including the git-visible file list, path resolution, and the text checks, lives in `project-files.ts`, which the read, edit, and create tools share.

## Structure: Tool checks

- No tool repeats the git, root, or link checks inline.

## Structure: Routing

- Routing is a table of path to handler, not a growing `if` chain inside one `fetch` function.

## Structure: Frontend modules

- Frontend modules are split per view. Each view owns its DOM and calls a shared typed API client.

## Structure: Typed client

- All backend-to-frontend data passes through a typed client in common, so the wire contract is compiled, not assumed.

## Structure: Streaming

- Streaming: the upstream module parses the upstream body into stream events, and the HTTP layer frames them as server-sent events. Raw upstream bytes are never forwarded. The frontend consumes the same stream event types from common.

## Structure: Merge gates

- Lint and typecheck are merge gates: `bun run lint` and `bun run typecheck` must pass under strict TypeScript rules.

## Potential Problems: Upstream outages

- Upstream outages stall the backend unless every request has a timeout. Only the wait for response headers is limited today.

## Potential Problems: Schema drift

- Upstream schema drift makes one odd field fail a whole chunk or model list, and the caller sees only a generic message.

## Potential Problems: Parse failures

- A parse failure is a structured `ParseError` with a field path. Callers match on its kind, and one bad streamed chunk still fails the whole reply rather than being skipped.

## Potential Problems: Shared upstream load

- Every page load hits the upstream, so rate limits and latency are shared by all users.

## Potential Problems: Re-sent conversation

- Each turn re-sends the conversation. Near the limit, compaction spends one extra upstream call on a summary; the budget drops the oldest messages only after that, once a conversation passes the context window less 4,000 tokens reserved for the reply.

## Potential Problems: Stream failures

- A stream that fails after the first byte has already returned HTTP 200, so the status code cannot report the failure.

## Potential Problems: Tool rounds

- Tool rounds sit outside the conversation budget, and each one re-sends the growing conversation. The round limit must stop the loop before it opens a request it will never read.

## Potential Problems: Approval timeout

- A waiting approval ends after ten minutes or when the client disconnects, and its registry entry is then released. A backend restart still drops every pending approval.

## Potential Problems: Tool output

- Tool output can mislead. A cut file's header still shows the whole line range, so a truncated read can look complete; the header must name the range actually returned.

## Potential Problems: Edits

- An edit matches exact text only, so a CRLF file cannot be edited, and a failed match is reported as text so the model can retry.

## Potential Problems: Stopped command runs

- When a command's run stops early, on timeout or cut output, only the podman client is killed; the container then ends on its own timer.

## Potential Problems: Podman

- A stopped podman machine fails every command. Exit codes 124 and 125 can also come from the command itself, so the message can name the wrong cause.

## Security Concerns: Trust boundary

- **Trust boundary**: the backend trusts nothing from upstream or from the browser. Both are validated. It accepts browser requests only from the frontend dev origin, `http://localhost:5173`, never a wildcard.

## Security Concerns: Key storage

- **Key exposure**: the UI-saved upstream API key is stored in a per-user config file outside the project (`%APPDATA%\vise\openrouter.env`), or read from the environment, and is never returned in responses or logs.

## Security Concerns: Key reach

- The UI sends it once, on save. No sandbox mount reaches that folder. The sandbox also masks the old `packages/backend/.env` path as defense in depth.

## Security Concerns: Key leaks through tools

- A command that reads another secret file inside the project can still send it upstream as tool output.

## Security Concerns: Open proxy

- **Open proxy**: any client that can reach the backend can spend the operator's upstream quota. Missing control: authentication on proxy routes.

## Security Concerns: Approval ids

- **Approvals**: approval ids are random UUIDs, and the answer route accepts an answer from any caller holding one.

## Security Concerns: Approval gate

- Approval is the only gate on a write or command. Each wait ends after ten minutes or when the client disconnects. Missing control: authentication on the route.

## Security Concerns: Command execution

- **Command execution**: the model may propose any shell command. It runs only after the user approves the command text, inside a throwaway podman container from the sandbox image.

## Security Concerns: Container mounts

- Only the project is mounted, read-write at `/workspace`; no host environment reaches the container; capabilities are dropped; and the run has a time limit. It never runs on the host and has no fallback.

## Security Concerns: Missing command controls

- Missing controls: a network policy, since installs need the network; a digest-pinned image; CPU, memory, and process limits; and a block on writes to git-ignored files and the mounted `.git` directory, whose hooks run when git runs.

## Security Concerns: Secrets and steering

- Any secret the mount reaches can leave through the network or the output. Tool output and file text can carry instructions that steer which command the user is asked to approve.

## Security Concerns: Chat budget

- **Chat input**: the backend enforces the conversation budget: the model's context window, less 4,000 tokens reserved for the reply.

## Security Concerns: Token estimates

- Before a send the backend can only estimate, at four characters per token; OpenRouter's usage count, which includes tool definitions, is shown in the meter after each reply.

## Security Concerns: Client-supplied turns

- The backend rejects any client-supplied system role, so the client cannot set the model's instructions. The client still supplies the assistant turns, so it can forge prior context. Each request spends paid upstream tokens.

## Security Concerns: Summary requests

- A compaction summary is sent with an empty tool list, so it can read no files and propose no changes. Missing controls: a backend-side model allowlist and authentication.

## Security Concerns: Path disclosure and tool output

- **Path disclosure and tool output**: the system context names the project root, and tool listings name project files. Both reach the upstream only, never the browser or local history. Tools skip git-ignored files.

## Security Concerns: Reading files

- The reading tool sends the contents of any git-visible file upstream, so a tracked file holding a secret leaks it.

## Security Concerns: Editing files

- The editing tool can rewrite any git-visible file, including files that run code when a developer runs the project, such as lint config, package scripts, and CI workflows.

## Security Concerns: Creating files

- The creating tool refuses git's own directories, where a hook would run code on the next git command. Symbolic links are refused, and only a path on the git list can be read or edited.

## Security Concerns: Path controls

- Missing controls: a denylist for secret-like paths and for executable config, applied by one shared path check that read, edit, create, and command execution all use.

## Security Concerns: Tool output limit

- Tool output is untrusted text that can carry injected instructions. Missing control: a byte cap on tool output across all rounds.

## Security Concerns: Local history

- **Local history**: the conversation is stored in browser localStorage as plain text. Anyone with access to the browser profile can read it, so it must never hold keys.

## Security Concerns: Rendering and logging

- **Rendering**: model metadata is untrusted text. It must be set with `textContent`, never `innerHTML`.
- **Logging**: error messages must not echo upstream bodies or request headers.

## Future Work: Structured errors

- A structured error enum for all failures, not only parsing, answering what failed, where, why, and how to fix it, mapped to HTTP status codes in one place.

## Future Work: Startup configuration

- Configuration loaded once at startup and validated, instead of read per request.

## Future Work: Models cache

- A response cache with a bounded TTL in front of the models upstream.

## Future Work: Route authentication

- Authentication on backend routes that proxy paid upstreams.

## Future Work: Size rules

- Size rules in `eslint.config.mjs` for lines per file, lines per function, and complexity, each limit documented here. The entries-per-folder limit of 10 is enforced by `eslint-rules/folder-file-limit.mjs`.

## Future Work: CRLF edits

- Exact-match edits that also accept CRLF files and keep each file's line endings.

## Future Work: Secrets outside the project

- Secrets kept outside the project root so the sandbox mount holds none, with the `.env` mask as defense in depth; a digest-pinned sandbox image; and a network policy that separates installs from test runs.

## Future Work: Compaction module

- Compaction as a pure, tested module in the frontend, outside the view. Its summary request runs without tools, and the summary is checked before it replaces history.

## Future Work: Tool output tests

- A byte cap on tool output, counted in the conversation budget, and tests for fragment merging, the file-listing helpers, and every refusal path of the reading tool: ignored, symbolic link, binary, oversized, and outside the root.

## Performance: Latency risk

- Upstream calls without caching are the main latency risk, and streams have no timeout after the reply's headers arrive.

## Performance: Window size

- The app is exactly the window size. The chat conversation is the only scroll region; every other section must fit the window or page its rows. Content clipped below the window is a defect, not a layout.

## Performance: Cost growth

- Re-sending the conversation on every turn makes cost grow with its length, so the shared budget caps each request.

## Performance: Output memory

- Command output is read as it arrives and stops at 20,000 characters per stream, so the cap bounds memory.

## Performance: File listing cost

- Each file tool call spawns git and rebuilds the file list, so one turn with several reads runs git several times. Cache the list per turn once a profile shows it matters.

## Performance: Profiling

- Nothing here has been profiled. Measure with a profiler before optimizing.
