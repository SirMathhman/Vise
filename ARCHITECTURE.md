# Vise Architecture

This document describes the target architecture. It is a reference for where the project should go, not a changelog.

## Definitions

- **Common**: the `packages/common` workspace. Holds the zod schemas and wire types (JSON exchanged between frontend and backend), plus pure helpers. It has no I/O; zod is its only runtime dependency.
- **Backend**: the `packages/backend` Bun server. It is the only code that holds secrets and the only code that talks to third-party APIs. An **upstream** is any external service it calls, such as OpenRouter.
- **Frontend**: the `packages/frontend` browser app. It renders data and never contacts third-party services directly.
- **Stream event**: a typed wire event in `common`: `delta`, `done`, `error`, or `approval`. Each reply ends with exactly one `done` or `error`, so a cut-off reply is never taken as finished. An `approval` waits for the user.
- **System context**: instructions the backend adds to every upstream request, such as the project root. Only the backend writes it. The wire request carries user and assistant turns only.
- **Local tool**: a backend-run function the model may call, such as reading files. Its output is untrusted text. A change or command returns an approval with an apply step; nothing runs until the user approves, and a file change re-checks the file first.
- **Decision**: the user's answer to an approval, `approve` or `reject`. It is a named union carried from the approval route to the tool loop, never a boolean; a wait that ends without an answer is `undefined`, a third state no boolean can express.
- **Sentinel**: an upstream value with a special meaning, such as a price of -1 for variable pricing. It maps to an explicit unknown in the wire type, never to arithmetic.
- **Compaction**: when a send would pass 80% of the model's window, the browser asks for a summary of older messages, then keeps the summary and the last ten messages. The summary turn applies no change and is not kept as history.
- **Invariant**: API keys never leave the backend. Every deserialization, including upstream responses, streamed chunks, request bodies, and saved history, goes through a zod schema via `parseJson`. ESLint bans `JSON.parse` and bare `.json()` calls elsewhere.

## Structure

Dependency direction is one way: frontend and backend depend on common, never the reverse. Backend and frontend do not import each other.

- Backend layers, from outside in: HTTP routing, then handlers, then upstream clients, then pure mapping functions. Each layer depends only on layers inside it.
- Each upstream gets its own module (`openrouter.ts` style) that owns its URL, auth, timeouts, validation, and error mapping.
- The tool loop, which decides when a tool runs and when the reply stops, is its own module. It depends on the upstream client, the tool registry, and the approval registry; none of them depends on it.
- The approval registry in `approvals.ts` holds the replies waiting on a user answer. Only the tool loop opens an approval and only the approval route answers one. It is scoped to a single reply and lives no longer than that reply.
- Local tools are registered in `tools/index.ts`, each with a zod argument schema. Process tools live in `shell/`, and the sandbox is the only path that starts a command. The loop dispatches by registry lookup.
- Routing is a table of path to handler, not a growing `if` chain inside one `fetch` function.
- Frontend modules are split per view. Each view owns its DOM and calls a shared typed API client.
- All backend-to-frontend data passes through a typed client in common, so the wire contract is compiled, not assumed.
- Streaming: the upstream module parses the upstream body into stream events, and the HTTP layer frames them as server-sent events. Raw upstream bytes are never forwarded. The frontend consumes the same stream event types from common.
- Lint and typecheck are merge gates: `bun run lint` and `bun run typecheck` must pass under strict TypeScript rules.

## Potential Problems

- Upstream outages stall the backend unless every request has a timeout. Only the wait for response headers is limited today.
- Upstream schema drift makes one odd field fail a whole chunk or model list, and the caller sees only a generic message.
- A parse failure is a structured `ParseError` with a field path. Callers match on its kind, and one bad streamed chunk still fails the whole reply rather than being skipped.
- Every page load hits the upstream, so rate limits and latency are shared by all users. Each turn re-sends the conversation. Near the limit, compaction adds one upstream summary call; the budget drops the oldest messages only after that.
- A stream that fails after the first byte has already returned HTTP 200, so the status code cannot report the failure.
- Tool rounds sit outside the conversation budget, and each one re-sends the growing conversation. The round limit must stop the loop before it opens a request it will never read.
- A waiting approval ends after ten minutes or when the client disconnects, and its registry entry is then released. A backend restart still drops every pending approval.
- Tool output can mislead. A cut file's header shows the whole range, so a truncated read looks complete; the header must name the range returned. Edits match exact text only, so CRLF files cannot be edited.
- A command stopped on timeout or cut output kills only the podman client; the container ends on its own timer. A stopped podman machine fails every command. Exit codes 124 and 125 can also come from the command itself.

## Security Concerns

- **Trust boundary**: the backend trusts nothing from upstream or from the browser. Both are validated. It accepts browser requests only from the frontend dev origin, `http://localhost:5173`, never a wildcard.
- **Key exposure**: the UI-saved key sits in `%APPDATA%iseopenrouter.env`, outside the project, or in the environment. It is never returned or logged, and no sandbox mount reaches it. A command can still read other project secrets and send them upstream.
- **Open proxy**: any client that can reach the backend can spend the operator's upstream quota. Missing control: authentication on proxy routes.
- **Approvals**: approval ids are random UUIDs, and the answer route accepts an answer from any caller holding one. Approval is the only gate on a write or command. Missing control: authentication on the route.
- **Command execution**: runs only after the user approves the command text, in a throwaway podman container that mounts only the project, read-write, with no host environment. Missing: network policy, digest pinning, resource limits.
- **Chat input**: the backend enforces the context budget less 4,000 reserved tokens. It rejects client system roles, but the client supplies assistant turns and can forge context. Missing: a model allowlist and authentication.
- **Path disclosure and tool output**: the read tool sends any git-visible file upstream, so a tracked secret leaks. Edit can rewrite executable config. Missing: a shared denylist for secret and executable paths, and a byte cap on output.
- **Local history**: the conversation is stored in browser localStorage as plain text. Anyone with access to the browser profile can read it, so it must never hold keys.
- **Rendering**: model metadata is untrusted text. It must be set with `textContent`, never `innerHTML`.
- **Logging**: error messages must not echo upstream bodies or request headers.

## Future Work

- A structured error enum for all failures, not only parsing, answering what failed, where, why, and how to fix it, mapped to HTTP status codes in one place.
- Configuration loaded once at startup and validated, instead of read per request.
- A response cache with a bounded TTL in front of the models upstream.
- Authentication on backend routes that proxy paid upstreams.
- Size rules in `eslint.config.mjs` for lines per file, lines per function, and complexity, each limit documented here. The entries-per-folder limit of 10 is enforced by `eslint-rules/folder-file-limit.mjs`.
- Exact-match edits that also accept CRLF files and keep each file's line endings.
- Secrets kept outside the project root so the sandbox mount holds none, with the `.env` mask as defense in depth; a digest-pinned sandbox image; and a network policy that separates installs from test runs.
- Compaction as a pure, tested module in the frontend, outside the view. Its summary request runs without tools, and the summary is checked before it replaces history.
- A byte cap on tool output, counted in the conversation budget, and tests for fragment merging, the file-listing helpers, and every refusal path of the reading tool: ignored, symbolic link, binary, oversized, and outside the root.

## Performance

- Upstream streams have no timeout after the reply's headers arrive, and the models list is uncached.
- The app is exactly the window size. The chat conversation is the only scroll region; every other section must fit the window or page its rows. Content clipped below the window is a defect, not a layout.
- Re-sending the conversation on every turn makes cost grow with its length, so the shared budget caps each request.
- Command output is read as it arrives and stops at 20,000 characters per stream, so the cap bounds memory.
- Each file tool call spawns git and rebuilds the file list, so one turn with several reads runs git several times. Cache the list per turn once a profile shows it matters.
- Nothing here has been profiled. Measure with a profiler before optimizing.
