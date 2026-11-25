# Vise Architecture

This document describes the target architecture. It is a reference for where the project should go, not a changelog.

## Definitions

- **Common**: the `packages/common` workspace. Holds shared types and pure helpers only. It has no I/O and no runtime dependencies.
- **Backend**: the `packages/backend` Bun server. It is the only code that holds secrets and the only code that talks to third-party APIs.
- **Frontend**: the `packages/frontend` browser app. It renders data and never contacts third-party services directly.
- **Upstream**: any external service the backend calls, such as OpenRouter.
- **Wire type**: a type in `common` that describes JSON exchanged between frontend and backend.
- **Invariant**: API keys never leave the backend. Upstream responses are validated before they become wire types.

## Structure

Dependency direction is one way: frontend and backend depend on common, never the reverse. Backend and frontend do not import each other.

- Backend layers, from outside in: HTTP routing, then handlers, then upstream clients, then pure mapping functions. Each layer depends only on layers inside it.
- Each upstream gets its own module (`openrouter.ts` style) that owns its URL, auth, timeouts, validation, and error mapping.
- Routing is a table of path to handler, not a growing `if` chain inside one `fetch` function.
- Frontend modules are split per view. Each view owns its DOM and calls a shared typed API client.
- All backend-to-frontend data passes through a typed client in common, so the wire contract is compiled, not assumed.

## Potential Problems

- Upstream outages or slowness stall the backend unless every upstream call has a timeout.
- Upstream schema drift can crash mapping code; responses must be validated at the boundary.
- Errors are thrown as exceptions and carried as plain strings, which makes failures hard to classify.
- Every page load hits the upstream, so rate limits and latency are shared by all users.

## Security Concerns

- **Trust boundary**: the backend trusts nothing from upstream or from the browser. Both are validated.
- **Key exposure**: the upstream API key is saved to the backend's git-ignored `.env` file, or read from the environment, and is never returned in responses or logs. The UI sends it once, on save.
- **Open proxy**: any client that can reach the backend can spend the operator's upstream quota. Missing control: authentication on proxy routes.
- **Cross-origin access**: the backend allows only the frontend dev origin, `http://localhost:5173`, with no wildcard.
- **Rendering**: model metadata is untrusted text. It must be set with `textContent`, never `innerHTML`.
- **Logging**: error messages must not echo upstream bodies or request headers.

## Future Work

- Typed, runtime-validated upstream clients with a shared `Result` type instead of exceptions.
- A structured error enum that answers what failed, where, why, and how to fix it, mapped to HTTP status codes in one place.
- Configuration loaded once at startup and validated, instead of read per request.
- A response cache with a bounded TTL in front of the models upstream.
- Authentication on backend routes that proxy paid upstreams.
- A linter enforcing function, file, and directory size limits, plus a documented limit for each.

## Performance

- Upstream calls without timeouts or caching are the main latency risk.
- Rendering a long model list as one unpaginated table will slow the page; large lists need paging or virtualization.
- Nothing here has been profiled. Measure with a profiler before optimizing.
