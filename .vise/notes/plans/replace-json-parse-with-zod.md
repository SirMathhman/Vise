# Plan: Replace All Raw JSON.parse Usages with Zod

Goal: every `JSON.parse` call in the codebase that produces a value validated by a `typeof` check or a manual type guard gets replaced with a zod schema parse. `JSON.parse` itself stays (zod validates already-parsed values, it doesn't parse JSON strings), but the *shape validation* after it moves to zod. A `parseJson` helper combines both steps into a single `Result<T>` return.

## Inventory of Raw JSON.parse Sites

| # | File | Function | What it parses | Current validation | Risk |
|---|------|----------|---------------|--------------------|------|
| 1 | `packages/core/src/goal.ts:124` | `ask()` | LLM reply content | None — `reply` typed `Record<string,unknown>` but could be any JSON value | Low (defensive `text()` access) |
| 2 | `packages/core/src/workflow.ts:364` | `parseArguments()` | Workflow tool args from LLM | Manual `typeof !== "object" || null || Array.isArray` | Low (returns Result) |
| 3 | `apps/web/src/conn/history.ts:33` | `parseArgs()` | Tool call args from session DB | Manual `typeof === "object" && !== null` | Low (display only, returns undefined) |
| 4 | `apps/web/src/ext/ext-hub.ts:101` | `handleMessage()` | Extension messages | None — destructured with optional fields | Low (early return on syntax error) |
| 5 | `packages/core/src/schemas/profile.ts:30` | `parseProfileText()` | `hooks:` frontmatter line | Manual `Array.isArray` + `every(typeof === "string")` | Low (falls to meta on failure) |
| 6 | `packages/backend/src/db/session/session-write.ts:84,89` | `readMessages()` | `tool_calls`, `images` DB columns | Zod AFTER JSON.parse, but **no try/catch around JSON.parse itself** | **MEDIUM — can crash entire read** |
| 7 | `apps/web/src/router/router.ts:173` | `handleMessage()` | WS wire messages | `parse(wireBaseSchema, raw)` after — **already correct** | None |

## What Can and Cannot Be Zod

Zod validates **already-parsed** `unknown` values. It does not parse JSON strings. So `JSON.parse` (step 1: string → unknown, can throw on syntax errors) stays. What changes is step 2 (shape validation) moving from manual `typeof` checks to `parse(schema, parsed)`. Sites 1–5 and 6 all have a manual type guard or no validation that can become a zod parse.

## New Helper: `parseJson`

Add to `packages/core/src/schemas/parse.ts` (next to the existing `parse<T>`):

```ts
/**
 * Parse a JSON string and validate the result against a zod schema.
 * Combines JSON.parse (step 1) and schema validation (step 2) into a
 * single Result. Returns a ViseError on JSON syntax failure or schema
 * mismatch.
 */
export function parseJson<T>(schema: z.ZodType<T>, json: string): Result<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: { kind: "malformed", body: `invalid JSON: ${json.slice(0, 200)}` } };
  }
  return parse(schema, parsed);
}
```

This becomes the canonical pattern for "read a JSON string from disk/DB/wire and validate its shape." Existing `parse(schema, JSON.parse(str))` sites can also switch to `parseJson(schema, str)` for the added protection.

## Phase-by-Phase Plan

### Phase A — Add `parseJson` helper + fix the crash (1 commit)

**A1.** Add `parseJson<T>` to `packages/core/src/schemas/parse.ts`. Export from `packages/core/src/index.ts`.

**A2.** Fix `packages/backend/src/db/session/session-write.ts` — wrap the two `JSON.parse` calls in `readMessages` (lines 84, 89) in try/catch. On syntax failure, skip the field (don't assign it to `m.tool_calls` / `m.images`), matching the existing "field dropped on bad data" pattern used elsewhere. Alternatively, replace `parse(schema, JSON.parse(str))` with `parseJson(schema, str)` and check `if (result.ok) m.tool_calls = result.value`.

This is the highest-priority fix: an unguarded `JSON.parse` in a `.map()` callback can crash the entire `readMessages` call if a single row is corrupted.

### Phase B — Replace manual type guards with zod (1 commit, can be one or two)

**B1. `packages/core/src/goal.ts` — `ask()`**

Replace:
```ts
const reply = JSON.parse(result.value.content);
return { ok: true, reply };
```
With:
```ts
const checked = parse(z.record(z.string(), z.unknown()), JSON.parse(result.value.content));
if (!checked.ok) { /* same catch-block behavior */ }
return { ok: true, reply: checked.value };
```

Or, since `JSON.parse` is in a try/catch already and the only thing missing is the "is it an object" check: keep the try/catch, replace the implicit assumption with an explicit `z.record(z.string(), z.unknown())` parse. The `catch` block stays as-is (returns `{ ok: false, why: ... }`).

Actually, simpler: just add the object check. The existing code doesn't even check `typeof` — if the LLM returns `"hello"` or `42`, it would be stored as `reply` with the wrong type. A `z.record(z.string(), z.unknown())` parse catches that. On failure, return `{ ok: false, why: ... }` (same as the JSON syntax error case).

**B2. `packages/core/src/workflow.ts` — `parseArguments()`**

Replace the manual `typeof` check:
```ts
if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
  throw new Error("expected an object");
}
return { ok: true, value: parsed as Record<string, unknown> };
```
With:
```ts
const checked = parse(z.record(z.string(), z.unknown()), parsed);
if (!checked.ok) {
  return { ok: false, error: { kind: "malformed", body: `workflow could not generate arguments for '${toolName}': expected an object` } };
}
return { ok: true, value: checked.value };
```

The `throw` → `return` change is a minor internal refactor (the function's catch block still handles JSON syntax errors).

**B3. `apps/web/src/conn/history.ts` — `parseArgs()`**

Replace:
```ts
return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : undefined;
```
With:
```ts
const checked = parse(z.record(z.string(), z.unknown()), parsed);
return checked.ok ? checked.value : undefined;
```

**B4. `apps/web/src/ext/ext-hub.ts` — `handleMessage()`**

Define a minimal schema for extension hub messages. The shape is `{ id?: number; ok?: boolean; result?: unknown; error?: string; event?: string; tab?: ShareEvent["tab"] }`. Create a `z.object` with all fields optional and validate. On failure, early return (same as current `catch` behavior).

```ts
const extHubMessageSchema = z.object({
  id: z.number().optional(),
  ok: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
  event: z.string().optional(),
  tab: z.string().optional(), // ShareEvent["tab"] is a string union
});
```

**B5. `packages/core/src/schemas/profile.ts` — `parseProfileText()`**

Replace:
```ts
const value: unknown = JSON.parse(h[1] ?? "");
if (Array.isArray(value) && value.every((c) => typeof c === "string")) {
  hooks = value as string[];
}
```
With:
```ts
const checked = parse(z.array(z.string()), JSON.parse(h[1] ?? ""));
if (checked.ok) hooks = checked.value;
```

The `catch` stays (treats bad JSON as a meta line).

### Phase C — Switch existing `parse(schema, JSON.parse(...))` sites to `parseJson` (optional, low priority)

Sites that already do `parse(schema, JSON.parse(str))` without a try/catch around `JSON.parse`:
- `session-write.ts:104` (`readTrace`) — already has try/catch, so it's fine as-is.
- `session-write.ts:84,89` — fixed in Phase A.
- `packages/backend/src/stores/workflows.ts:147` (`parseWorkflowJson`) — check if it has try/catch.
- `packages/backend/src/stores/sessions.ts:118` (`storedTodos`) — check if it has try/catch.

For any of these that lack a try/catch, switch to `parseJson(schema, str)` for the added protection. If they already have try/catch, the switch is optional (just cleaner code, no behavioral change).

### Phase D — Tests (1 commit)

For each changed site, add or update tests:

- `parseJson` helper: valid JSON + valid shape → ok; valid JSON + wrong shape → err; invalid JSON → err with "invalid JSON" prefix
- `goal.ts` `ask()`: LLM returns a JSON string (not object) → `ok: false`
- `workflow.ts` `parseArguments`: LLM returns array → err; returns `null` → err
- `session-write.ts` `readMessages`: corrupted `tool_calls` row → field dropped, no crash
- `profile.ts` `parseProfileText`: `hooks:` with invalid JSON → treated as meta (existing test covers this)

## What Does NOT Change

- **`router.ts:173`** — already correct (try/catch + `parse(wireBaseSchema, raw)`). The `JSON.parse` try/catch is necessary and the zod parse is there. No change.
- **`engine.ts:387`** (`parseArgs` in engine.ts) — this one already has a try/catch and a `typeof` guard, then the result is validated by `toolCallArgsSchema` at the dispatch point (line 407). The `typeof` guard could be replaced with a zod check for consistency, but it's low value since `toolCallArgsSchema` already validates `{ name, arguments }` — a non-object would fail there. **Skip** unless we want pure consistency.
- **`workflow.ts` `parseWorkflowJson`** — already uses `parse(workflowSchema, ...)` after JSON.parse. If the JSON.parse is already in a try/catch, no change needed.

## Decisions

1. **`parseJson` lives in `parse.ts`** next to `parse<T>`. It's a thin wrapper (5 lines) that reduces boilerplate and guarantees no `JSON.parse` escapes without a syntax-error guard.

2. **The "is it an object" check** in goal.ts, workflow.ts, history.ts is `z.record(z.string(), z.unknown())`. This is the most permissive object schema — it accepts any JSON object and rejects strings, numbers, arrays, null, booleans. It does not validate the fields (that's the caller's job or a separate schema).

3. **`session-write.ts` crash fix** uses `parseJson` (the new helper) rather than just adding a try/catch. This way the error is reported in the `Result` rather than propagating.

4. **No new schemas for goal.ts** — the LLM reply shape varies by call purpose (the `schema` parameter is dynamic). A static zod schema can't cover all purposes. The object check is sufficient; the `text()` helper already handles missing/wrong-type fields defensively.

5. **Phase A is the only urgent fix.** Phases B and C are consistency/cleanliness. If time-constrained, do A+B2+B3+B5 (the ones in `core/src` where the pattern should be canonical), then B1, B4, C as follow-up.

## Verification

1. `bunx tsc --noEmit` — no type errors
2. `bun test` — all tests pass
3. New tests for `parseJson` and the changed sites
4. Manual: corrupt a session DB row's `tool_calls` column with invalid JSON → verify `readMessages` doesn't crash, just drops the field
