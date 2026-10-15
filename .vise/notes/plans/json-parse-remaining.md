# Plan: Zod for Remaining JSON.parse Sites (Part 2)

Continuation of the `replace-json-parse-with-zod` plan. All sites in `packages/core/src/`, `packages/backend/src/`, and `apps/web/src/` are already done. This covers the 5 remaining production sites that were missed.

**Steps**

## Phase 1 — Extension background (1 commit)

### 1a. `apps/extension/src/background.ts:39` — `handle()`

**Current code:**
```ts
let msg: Record<string, unknown>;
try {
  msg = JSON.parse(raw);
} catch {
  return;
}
if (typeof msg["config"] === "object" && msg["config"] !== null) {
  const config = msg["config"] as Record<string, unknown>;
  const limit = config["tabLimit"];
  if (typeof limit === "number" && Number.isInteger(limit) && limit >= 1) {
    setTabLimit(limit);
    void browser.storage.local.set({ tabLimit: limit });
  }
  return;
}
const request = msg as { id: number; op: string; params?: Record<string, unknown> };
```

**Replace with:**
- Define `backgroundMessageSchema` as a discriminated union:
  - `{ config: z.object({ tabLimit: z.number().int().min(1) }) }`
  - `{ id: z.number(), op: z.string(), params: z.record(z.string(), z.unknown()).optional() }`
- After `JSON.parse` in the try block, call `parse(backgroundMessageSchema, parsed)`.
- On `!ok`, return (same as current catch behavior).
- On success, narrow by `"config" in value` vs `"op" in value`.
- For the config variant: `value.config.tabLimit` is already validated.
- For the request variant: `value.id`, `value.op`, `value.params` are already validated.

**Note:** The extension cannot import from `@vise/core` (it's a standalone browser script with no build step beyond a single bundle). The schema must be defined inline in `background.ts` using a direct `import { z } from "zod"` (zod is already a dependency). If the bundler doesn't inline zod, define the schema as a plain object and use `z.parse` with a local import. Check how the extension is built (`scripts/build-extension` or similar) before deciding.

**Alternative if zod import is problematic in the extension:** Use a plain type guard function instead (no zod). The pattern would be:
```ts
function isConfigMessage(msg: unknown): msg is { config: { tabLimit: number } } { ... }
function isRequestMessage(msg: unknown): msg is { id: number; op: string; params?: Record<string, unknown> } { ... }
```
This is a fallback — prefer zod if the build supports it.

## Phase 2 — Frontend app (1 commit)

### 2a. `packages/frontend/src/app.ts:431` — `onMessage()`

**Current code:**
```ts
let message: ServerMessage;
try {
  message = JSON.parse(data) as ServerMessage;
} catch {
  return;
}
```

**Replace with:**
- Define a minimal `serverMessageBaseSchema = z.object({ type: z.string() })` inline (or in a small local module).
- After `JSON.parse`, call `parse(serverMessageBaseSchema, parsed)`.
- On `!ok`, return (same as current catch).
- On success, cast `parsed` to `ServerMessage` (the rest of the shape is guaranteed by the server).

This mirrors the pattern already in `apps/web/src/router/router.ts` where `parse(wireBaseSchema, raw)` is used.

### 2b. `packages/core/src/engine.ts:387` — `parseArgs()`

**Current code:**
```ts
function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
```

**Replace with:**
```ts
function parseArgs(raw: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    const checked = parse(z.record(z.string(), z.unknown()), parsed);
    return checked.ok ? checked.value : undefined;
  } catch {
    return undefined;
  }
}
```

This is pure consistency — the result is validated by `toolCallArgsSchema` at dispatch anyway.

## Phase 3 — Frontend utilities (1 commit)

### 3a. `packages/frontend/src/settings/workflows/arg-rows.ts:22` — `fixedValue()`

**Current code:**
```ts
function fixedValue(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "string") return parsed;
  } catch {
    // not JSON: it is a plain string
  }
  return text;
}
```

**Replace with:**
```ts
function fixedValue(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    // Accept numbers, booleans, objects, arrays — reject strings (fall back to raw text).
    if (typeof parsed === "number" || typeof parsed === "boolean" || typeof parsed === "object" && parsed !== null) return parsed;
  } catch {
    return text;
  }
  return text;
}
```

Actually, the current code is already correct and minimal. The `typeof parsed !== "string"` guard is the exact check needed: accept anything that's not a string (number, boolean, object, array), fall back to the raw text for strings. Replacing with a zod schema here adds complexity without benefit (a zod schema for "any non-string JSON value" doesn't exist as a primitive). **Skip** — the manual guard is the simplest correct implementation.

### 3b. `packages/frontend/src/models/model-picker.ts:56` — `readRecent()`

**Current code:**
```ts
function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(storage.get(RECENT_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}
```

**Replace with:**
```ts
function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(storage.get(RECENT_KEY) ?? "[]");
    const checked = parse(z.array(z.string()), value);
    if (!checked.ok) return [];
    return checked.value.slice(0, RECENT_MAX);
  } catch {
    return [];
  }
}
```

This is cleaner: the zod schema validates the whole shape (array of strings) in one step, replacing both the `Array.isArray` check and the `filter`.

## Phase 4 — Tests (1 commit)

- `engine.ts` `parseArgs`: covered by existing engine tests (no new test needed — behavior unchanged)
- `app.ts` `onMessage`: covered by existing frontend tests
- `arg-rows.ts`: skip (no change)
- `model-picker.ts` `readRecent`: add a test that a non-array value returns `[]`, and an array with non-string entries returns `[]` (the old code would have filtered; the new code rejects the whole array). **Check existing tests first** — if there's a test that expects partial filtering (e.g., `["valid", 42, "also-valid"]` → `["valid", "also-valid"]`), that test must be updated since the new behavior rejects the whole array.
- `background.ts`: the extension has no test infrastructure. Manual verification only.

**Verification**

1. `bunx tsc --noEmit` — no new errors
2. `bun test` — all tests pass (update any that conflict with the new `readRecent` behavior)
3. Manual: open the web UI in a browser, open DevTools → Application → Storage → check that recent models still work after the change
4. Manual: load the Firefox extension, send a malformed WS message via the server's WS endpoint — verify it's dropped, not a crash

**Relevant files**

- `apps/extension/src/background.ts` — wire protocol handler (add schema or type guard)
- `packages/frontend/src/app.ts` — `onMessage` (add base check)
- `packages/core/src/engine.ts` — `parseArgs` (consistency)
- `packages/frontend/src/models/model-picker.ts` — `readRecent` (zod array)
- `packages/frontend/src/settings/workflows/arg-rows.ts` — `fixedValue` (SKIP — already minimal)
- `packages/core/src/schemas/parse.ts` — `parse<T>` helper (reuse)
- `apps/web/src/router/router.ts` — reference pattern for `wireBaseSchema`-style check

**Decisions**

1. **`arg-rows.ts` is skipped.** The `typeof !== "string"` guard is the simplest correct check for "accept any non-string JSON value." A zod schema would be more verbose for the same result.
2. **`background.ts` prefers zod if the extension's build supports it.** The extension is bundled (check `scripts/` or `package.json` for how it's built). If zod can't be imported, fall back to plain type guard functions.
3. **`app.ts` uses a minimal base check** (`z.object({ type: z.string() })`), not a full discriminated union. This matches the existing `wireBaseSchema` pattern in the router and avoids duplicating the full `ServerMessage` type in the frontend.
4. **`model-picker.ts` behavior change is acceptable.** The old code filtered non-string entries from the array; the new code rejects the whole array. This is a stricter (correct) behavior: a corrupted storage value shouldn't partially load.
5. **No changes to test files.** All 13 test hits parse SUT-produced data — no change needed.

**Scope boundaries**

- Included: `background.ts`, `app.ts`, `engine.ts`, `model-picker.ts`
- Excluded: `arg-rows.ts` (already minimal), all test files, all sites already covered by Part 1
