# Vise Architecture

This document describes the target architecture. It is a reference for where the project should go, not a changelog.

## Definitions

- **Common**: the `packages/common` workspace. Holds the zod schemas and wire types (JSON exchanged between frontend and backend), plus pure helpers. It has no I/O; zod is its only runtime dependency.
- **Backend**: the `packages/backend` Bun server. It is the only code that holds secrets and the only code that talks to third-party APIs.
- **Frontend**: the `packages/frontend` browser app. It renders data and never contacts third-party services directly.
- **Upstream**: any external service the backend calls, such as OpenRouter.
- **Stream event**: a typed wire event in `common`: `delta`, `done`, `error`, or `approval`. Every streamed reply ends with exactly one `done` or `error`, so a cut-off reply is never mistaken for a finished one. An `approval` is not an ending: the reply waits until the user answers it.
- **System context**: instructions the backend adds to every upstream request, such as the project root. Only the backend writes it. The wire request carries user and assistant turns only.
- **Local tool**: a function the model may call that the backend runs itself, such as listing or reading project files. Its schema is owned by the backend and its output is untrusted text. A tool that changes a file never writes directly: it returns an approval, a title and body shown to the user plus an apply step, and the apply step runs only after the user approves and re-checks the file first.
- **Sentinel**: an upstream value with a special meaning, such as a price of -1 for variable pricing. It maps to an explicit unknown in the wire type, never to arithmetic.
- **Invariant**: API keys never leave the backend. Every deserialization, including upstream responses, streamed chunks, request bodies, and saved history, goes through a zod schema via `parseJson`. ESLint bans `JSON.parse` and bare `.json()` calls elsewhere.

## Structure

Dependency direction is one way: frontend and backend depend on common, never the reverse. Backend and frontend do not import each other.

- Backend layers, from outside in: HTTP routing, then handlers, then upstream clients, then pure mapping functions. Each layer depends only on layers inside it.
- Each upstream gets its own module (`openrouter.ts` style) that owns its URL, auth, timeouts, validation, and error mapping.
- The tool loop, which decides when a tool runs and when the reply stops, is its own module. It depends on the upstream client, the tool registry, and the approval registry; none of them depends on it.
- The approval registry in `approvals.ts` holds the replies waiting on a user answer. Only the tool loop opens an approval and only the approval route answers one. It is scoped to a single reply and lives no longer than that reply.
- Local tools are registered in `packages/backend/src/tools/index.ts`. Each has a zod argument schema. The loop dispatches by registry lookup and names no tool. Tools receive the project root as a parameter. All project file access, including the git-visible file list, path resolution, and the text checks, lives in `project-files.ts`, which the read, edit, and create tools share. No tool repeats the git, root, or link checks inline.
- Routing is a table of path to handler, not a growing `if` chain inside one `fetch` function.
- Frontend modules are split per view. Each view owns its DOM and calls a shared typed API client.
- All backend-to-frontend data passes through a typed client in common, so the wire contract is compiled, not assumed.
- Streaming: the upstream module parses the upstream body into stream events, and the HTTP layer frames them as server-sent events. Raw upstream bytes are never forwarded. The frontend consumes the same stream event types from common.
- Lint and typecheck are merge gates: `bun run lint` and `bun run typecheck` must pass under strict TypeScript rules.

## Potential Problems

- Upstream outages or slowness stall the backend unless every upstream call has a timeout.
- Upstream schema drift makes one odd field fail a whole chunk or model list, and the caller sees only a generic message.
- A parse failure is a structured `ParseError` with a field path. Callers match on its kind, and one bad streamed chunk still fails the whole reply rather than being skipped.
- Every page load hits the upstream, so rate limits and latency are shared by all users.
- Each turn re-sends the conversation, so the shared budget drops the oldest messages once a conversation passes 40 messages or 20,000 characters.
- A stream that fails after the first byte has already returned HTTP 200, so the status code cannot report the failure.
- Tool rounds sit outside the conversation budget, and each one re-sends the growing conversation. The round limit must stop the loop before it opens a request it will never read.
- A cut file's header still shows the whole line range, so a truncated read can look complete. The header must name the range actually returned.
- A waiting approval ends after ten minutes or when the client disconnects, and its registry entry is then released. A backend restart still drops every pending approval.
- An edit matches exact text only, so a CRLF file cannot be edited. A failed match is reported to the model as text, so it can retry with corrected text.

## Security Concerns

- **Trust boundary**: the backend trusts nothing from upstream or from the browser. Both are validated.
- **Key exposure**: the upstream API key is saved to the backend's git-ignored `.env` file, or read from the environment, and is never returned in responses or logs. The UI sends it once, on save.
- **Open proxy**: any client that can reach the backend can spend the operator's upstream quota. Missing control: authentication on proxy routes.
- **Approvals**: an approval id is a random UUID, and the approval route accepts an answer from any caller who holds it. Approval is the only gate on a file write. Each wait ends after ten minutes or when the client disconnects. Missing control: authentication on the route.
- **Chat input**: the backend enforces the shared conversation budget of 40 messages and 20,000 characters. The backend rejects any client-supplied system role, so the client cannot set the model's instructions. The client still supplies the assistant turns, so it can forge prior context. Each request spends paid upstream tokens. Missing controls: a backend-side model allowlist and authentication.
- **Path disclosure and tool output**: the system context names the project root, and tool listings name project files. Both reach the upstream only, never the browser or local history. Tools skip git-ignored files. The reading tool sends the contents of any git-visible file upstream, so a tracked file holding a secret leaks it. The editing tool can rewrite any git-visible file, including files that run code when a developer runs the project, such as lint config, package scripts, and CI workflows. The creating tool refuses git's own directories, where a hook would run code on the next git command. Missing controls: a denylist for secret-like paths and for executable config, applied by one shared path check that read, edit, and create all use. Symbolic links are refused, and only a path on the git list can be read or edited. Tool output is untrusted text that can carry injected instructions. Missing control: a byte cap on tool output across all rounds.
- **Local history**: the conversation is stored in browser localStorage as plain text. Anyone with access to the browser profile can read it, so it must never hold keys.
- **Cross-origin access**: the backend allows only the frontend dev origin, `http://localhost:5173`, with no wildcard.
- **Rendering**: model metadata is untrusted text. It must be set with `textContent`, never `innerHTML`.
- **Logging**: error messages must not echo upstream bodies or request headers.

## Future Work

- A structured error enum for all failures, not only parsing, answering what failed, where, why, and how to fix it, mapped to HTTP status codes in one place.
- Configuration loaded once at startup and validated, instead of read per request.
- A response cache with a bounded TTL in front of the models upstream.
- Authentication on backend routes that proxy paid upstreams.
- Size rules in `eslint.config.mjs` for lines per file, lines per function, complexity, and entries per directory, each limit documented here.
- Exact-match edits that also accept CRLF files and keep each file's line endings.
- A byte cap on tool output, counted in the conversation budget, and tests for fragment merging, the file-listing helpers, and every refusal path of the reading tool: ignored, symbolic link, binary, oversized, and outside the root.

## Performance

- Upstream calls without timeouts or caching are the main latency risk.
- The app is exactly the window size. The chat conversation is the only scroll region; every other section must fit the window or page its rows. Content clipped below the window is a defect, not a layout.
- Re-sending the conversation on every turn makes cost grow with its length, so the shared budget caps each request.
- Each file tool call spawns git and rebuilds the file list, so one turn with several reads runs git several times. Cache the list per turn once a profile shows it matters.
- Nothing here has been profiled. Measure with a profiler before optimizing.
