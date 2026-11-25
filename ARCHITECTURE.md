# Vise Architecture

This document describes the target architecture. It is a reference for where the project should go, not a changelog.

## Definitions

- **Common**: the `packages/common` workspace. Holds shared types and pure helpers only. It has no I/O and no runtime dependencies.
- **Backend**: the `packages/backend` Bun server. It is the only code that holds secrets and the only code that talks to third-party APIs.
- **Frontend**: the `packages/frontend` browser app. It renders data and never contacts third-party services directly.
- **Upstream**: any external service the backend calls, such as OpenRouter.
- **Wire type**: a type in `common` that describes JSON exchanged between frontend and backend.
- **Stream event**: a typed wire event in `common`: `delta`, `done`, or `error`. Every streamed reply ends with exactly one `done` or `error`, so a cut-off reply is never mistaken for a finished one.
- **Sentinel**: an upstream value with a special meaning, such as a price of -1 for variable pricing. It maps to an explicit unknown in the wire type, never to arithmetic.
- **Invariant**: API keys never leave the backend. Every upstream response, including each streamed chunk, is validated by a runtime guard before it becomes a wire type.

## Structure

Dependency direction is one way: frontend and backend depend on common, never the reverse. Backend and frontend do not import each other.

- Backend layers, from outside in: HTTP routing, then handlers, then upstream clients, then pure mapping functions. Each layer depends only on layers inside it.
- Each upstream gets its own module (`openrouter.ts` style) that owns its URL, auth, timeouts, validation, and error mapping.
- Routing is a table of path to handler, not a growing `if` chain inside one `fetch` function.
- Frontend modules are split per view. Each view owns its DOM and calls a shared typed API client.
- All backend-to-frontend data passes through a typed client in common, so the wire contract is compiled, not assumed.
- Streaming: the upstream module parses the upstream body into stream events, and the HTTP layer frames them as server-sent events. Raw upstream bytes are never forwarded. The frontend consumes the same stream event types from common.
- Lint and typecheck are merge gates: `bun run lint` and `bun run typecheck` must pass under strict TypeScript rules.

## Potential Problems

- Upstream outages or slowness stall the backend unless every upstream call has a timeout.
- Upstream schema drift can crash mapping code; responses must be validated at the boundary.
- Errors are thrown as exceptions and carried as plain strings, which makes failures hard to classify.
- Every page load hits the upstream, so rate limits and latency are shared by all users.
- A stream that fails after the first byte has already returned HTTP 200, so the status code cannot report the failure.

## Security Concerns

- **Trust boundary**: the backend trusts nothing from upstream or from the browser. Both are validated.
- **Key exposure**: the upstream API key is saved to the backend's git-ignored `.env` file, or read from the environment, and is never returned in responses or logs. The UI sends it once, on save.
- **Open proxy**: any client that can reach the backend can spend the operator's upstream quota. Missing control: authentication on proxy routes.
- **Chat input**: message length and model id are unbounded on the chat route, and each request spends paid upstream tokens. Missing controls: a length cap, a backend-side model allowlist, and authentication.
- **Cross-origin access**: the backend allows only the frontend dev origin, `http://localhost:5173`, with no wildcard.
- **Rendering**: model metadata is untrusted text. It must be set with `textContent`, never `innerHTML`.
- **Logging**: error messages must not echo upstream bodies or request headers.

## Future Work

- Typed, runtime-validated upstream clients with a shared `Result` type instead of exceptions.
- Runtime validation of every backend response in the frontend API client, so the wire contract is checked, not cast.
- A structured error enum that answers what failed, where, why, and how to fix it, mapped to HTTP status codes in one place.
- Configuration loaded once at startup and validated, instead of read per request.
- A response cache with a bounded TTL in front of the models upstream.
- Authentication on backend routes that proxy paid upstreams.
- Size rules in `eslint.config.mjs` for lines per file, lines per function, complexity, and entries per directory, each limit documented here.

## Performance

- Upstream calls without timeouts or caching are the main latency risk.
- The app is exactly the window size. The chat conversation is the only scroll region; every other section must fit the window or page its rows. Content clipped below the window is a defect, not a layout.
- Sending an unbounded message upstream raises cost and latency for every chat request.
- Nothing here has been profiled. Measure with a profiler before optimizing.
