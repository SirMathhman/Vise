## Plan: Consistent Serialization with Zod

Add `zod` as the single runtime-validation layer at every trust boundary. Schemas live in `packages/core` (pure JS, no `node:` imports — compatible with core's purity rule). All parse calls return `Result<T>` (the existing `Result` union from `packages/core/src/errors.ts`; a parse failure is `{ kind: "malformed", body: <raw text> }`).

**What it covers (all paths):**

- Disk → code: sessions DB, notes, profiles, workflows, MCP config, settings `.env`, audit DB
- Code → disk: ensure serialized shapes match the schema before write
- Page → server (WebSocket): all `WireMessage` variants
- Server → page (WebSocket): TypeScript discriminated unions for compile-time safety; light runtime type check in the frontend
- Model output → code: tool-call `arguments` JSON

---

**Phase 0 — Setup**

1. Add `zod` to root `package.json` `dependencies` (Bun workspace; one hoisted copy for all packages). Pin to a stable major (current latest is 4.x; if 4.x is too new, 3.25 is battle-tested).
2. Create `packages/core/src/schemas/` directory. Each file exports zod schemas plus a small parse helper.
3. Create `packages/core/src/schemas/parse.ts`:
   - `parse<T>(schema, data: unknown): Result<T>` — calls `schema.safeParse(data)`; on success returns `{ ok: true, value }`, on failure returns `{ ok: false, error: { kind: "malformed", body: <formatted zod issues + raw JSON> } }`.
   - `parseOrThrow` is NOT introduced; callers always get `Result<T>`.
   - The `body` string should be human-readable (zod's `error.issues` formatted as `"field.path: message"` lines, joined with `\n`, prefixed with the raw input truncated to ~500 chars).

**Phase 1 — Core schemas (all in `packages/core/src/schemas/`)**

Each schema file is pure (no `node:` imports, no `process`). Types are derived from the schemas (`z.infer<typeof X>`), replacing the hand-written interfaces where practical, or the hand-written types stay as the canonical type and the schema is annotated with a `satisfies` clause to keep them in sync.

| File             | Schemas                                                                                                                                                     | Replaces                                                                                                                           | Covers                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `todo.ts`        | `todoItemSchema`, `todosSchema`                                                                                                                             | `parseTodos` in `core/src/todos.ts`                                                                                                | Session todos column                                 |
| `message.ts`     | `pictureSchema`, `toolCallSchema`, `messageSchema`                                                                                                          | none (no existing validator for `Message`/`Picture`/`ToolCall` in session read)                                                    | Sessions DB `tool_calls`, `images` columns           |
| `goal-trace.ts`  | `goalTraceFactSchema` (discriminated union on `kind`), `goalTraceEntrySchema` (fact + `at` + `after`)                                                       | the try/catch in `readTrace()` (session-write.ts:97–105)                                                                           | Sessions DB goal_trace table                         |
| `workflow.ts`    | `workflowStepSchema` (discriminated union: `instruction`/`profile`/`tool`), `workflowSchema`                                                                | `validateWorkflow` + `validateStep` in `backend/src/stores/workflows.ts:152–195`                                                   | Workflow `.json` files; Web editor save path         |
| `mcp.ts`         | `mcpServerSpecSchema` (discriminated: `command` present = stdio, `url` present = remote), `mcpFileSchema` (`{ mcpServers: Record<string, mcpServerSpec> }`) | `parseServer`, `isRecord`, `isStringMap` in `backend/src/mcp/mcp-config.ts:28–62`                                                  | MCP config `.json` files; Web settings save path     |
| `profile.ts`     | `profileFrontmatterSchema` (lines: `tools?` string, `hooks?` JSON-array-of-strings, rest = meta), `profileFileSchema` (frontmatter block + body)            | `parseProfile` in `backend/src/stores/profiles.ts:71–105`                                                                          | Profile `.md` files                                  |
| `settings.ts`    | `settingValueSchema` (string with no embedded newlines; if the spec says numeric, coerce and check `>= min`)                                                | `problem()` in `backend/src/settings/settings-file.ts:41–48`                                                                       | Settings `.env` file; Web settings save path         |
| `audit-event.ts` | `auditEventSchema` (discriminated union on `kind`, ~15 variants)                                                                                            | none (no existing validator; the write side constructs events in-memory, but the read path in `audit-query.ts` maps rows manually) | Audit DB read-back (for `/audit` display and export) |
| `tool-args.ts`   | `toolCallArgsSchema` (object: `name` string, `arguments` object) — used to validate the parsed JSON before passing to a handler                             | none (currently unchecked)                                                                                                         | Model output → tool dispatch                         |

**Phase 2 — Wire schemas (page→server)**

File: `packages/core/src/schemas/wire.ts` (or `apps/web/src/router/wire-schemas.ts` if the message types are considered web-app-specific).

Define a discriminated union by `type` literal:

```ts
const lineSchema = z.object({ type: z.literal("line"), text: z.string(), qid: z.string().optional(), images: z.array(z.unknown()).optional() });
// …one per message type…
export const wireMessageSchema = z.discriminatedUnion("type", [lineSchema, steerSchema, unqueueSchema, envGetSchema, envSetSchema, …]);
```

The router's `handleMessage` (apps/web/src/router/router.ts:138) replaces its `typeof msg?.type !== "string"` guard with `parse(wireMessageSchema, parsed)`. On failure, log the error and drop the message (current behavior for bad payloads).

Each existing `typeof` guard inside handlers (`handleLineFamily`: text, qid; `handleSettingsMessage`: values is a Record; etc.) becomes redundant and can be removed — the schema guarantees the shape.

**Phase 3 — Server→page types**

Refactor `packages/frontend/src/server-message.ts` from the flat 66-field interface to a **discriminated union** by `type` literal:

```ts
type ServerMessage =
  | { type: "history"; entries: HistoryEntry[] }
  | { type: "token"; text: string }
  | { type: "lists"; lists: ListsSnapshot }
  | { type: "state"; running: boolean; steerable: boolean };
// …one per message type…;
```

The frontend's `handleServerMessage` (app.ts:418) switches on the narrowed `type` and each branch gets its fields without optional chains. No zod runtime validation on the frontend (the server builds these messages from trusted code); the discriminated union is the compile-time guarantee.

The server's `send` function stays `Record<string, unknown>` (no runtime cost); TypeScript's type checking at the call site ensures the shape.

**Phase 4 — Store integration**

Replace each hand-rolled validator with the corresponding schema + `parse()` call:

1. **Sessions** (`backend/src/stores/session-write.ts` + `sessions.ts`):
   - `storedTodos()` → `parse(todosSchema, JSON.parse(json))` — returns `Result<TodoItem[]>` as before.
   - `readMessages()`: wrap `JSON.parse(r.tool_calls)` in `parse(messageSchema, …)` for the `tool_calls` field, `parse(pictureSchema.array, …)` for `images`. On failure, return the message with the field dropped (or log + drop the whole message — decide per field).
   - `readTrace()`: replace the try/catch with `parse(goalTraceEntrySchema, entry)`; skip entries that fail (same behavior as today).

2. **Profiles** (`backend/src/stores/profiles.ts`):
   - `parseProfile()` → `parse(profileFileSchema, fileText)`. The schema handles the frontmatter regex internally (zod's `.regex()` or a pre-transform). On failure, fall back to `{ body: fileText, meta: [], tools: undefined, hooks: undefined }` (the current fallback for a file without frontmatter).
   - `parseHookList()` is absorbed into the schema.

3. **Workflows** (`backend/src/stores/workflows.ts`):
   - `loadWorkflow()` → `parse(workflowSchema, JSON.parse(text))`. On failure, return the `Result` error (replacing the current `throw`). `readWorkflowAt` already returns `Result<Workflow>` — just swap the internal call.
   - `saveWorkflowAt()` → `parse(workflowSchema, { steps })` before writing (replacing `validateWorkflow`).

4. **MCP** (`backend/src/mcp/mcp-store.ts` + `mcp-config.ts`):
   - `parseServer()` → `parse(mcpServerSpecSchema, value)`. The `McpServerSpec` type is now `z.infer<typeof mcpServerSpecSchema>`.
   - `readFile()` / `readEntries()`: wrap in `parse(mcpFileSchema, parsed)`. On failure, skip the file (same as today).
   - `saveEntry()`: `parse(mcpServerSpecSchema, entry)` before calling `edit()`.

5. **Settings** (`backend/src/settings/settings-file.ts`):
   - `problem()` → `parse(settingValueSchema, value)` per setting. The schema knows whether the value must be numeric (from the `Spec` definition) and enforces `>= min`.
   - `saveSettings()`: replace the inline `problem()` call with the schema parse. Reject unknown names as before.

6. **Audit** (`backend/src/db/audit/audit-query.ts`):
   - `callOf()` and similar row-mapping functions: after building the `AuditCall` object from row fields, validate with `parse(auditCallSchema, obj)`. This catches schema drift if the DB migration lagged.
   - The write side (`audit-store.ts`): before `JSON.stringify` of `tool_calls`/`images`/`args`/`payload`, the values are already typed in-memory (no validation needed), but a `parse(toolCallSchema, …)` guard on `tool_calls` prevents a malformed model response from corrupting the DB.

7. **Tool arguments** (`backend/src/tools/` or wherever `ToolRunner.run` parses the model's `<|tool_call|>` JSON):
   - After `JSON.parse(argumentsString)`, validate with `parse(toolCallArgsSchema, parsed)` before dispatching to the handler. On failure, return `error: malformed tool arguments for <name>: <zod issues>`. This is a new validation that doesn't exist today.

**Phase 5 — Cleanup & migration**

- Remove `parseTodos` from `core/src/todos.ts` (re-export from the schema file, or just import the new one).
- Remove `validateWorkflow`/`validateStep` from `backend/src/stores/workflows.ts`.
- Remove `parseServer`/`isRecord`/`isStringMap` from `backend/src/mcp/mcp-config.ts`.
- Remove `parseProfile`/`parseHookList` from `backend/src/stores/profiles.ts`.
- Remove `problem()` from `backend/src/settings/settings-file.ts`.
- Update all import sites.
- The hand-written types (`Message`, `ToolCall`, `Picture`, `TodoItem`, `WorkflowStep`, `McpServerSpec`, etc.) stay as the canonical exported types; schemas are annotated with `satisfies z.ZodType<MsgType>` (or similar) so TypeScript catches drift. Alternatively, switch to `z.infer` as the type and re-export — pick one approach and be consistent.

**Phase 6 — Tests**

For each schema, a test file in `packages/core/test/schemas/` (or alongside the schema file):

- `parse` success (valid data in, expected `Result.ok`)
- `parse` failure (invalid data in, expected `Result.err` with the right field path in the error body)
- Edge cases: empty arrays, missing optional fields, wrong types, deeply nested bad values

Integration-level tests in `test/`:

- Corrupt a session DB row, `loadSession`, verify graceful degradation
- Corrupt a workflow `.json`, verify `loadWorkflow` returns a `Result.err` (not a throw)
- Send a malformed WS message, verify it's dropped and logged
- Model returns bad tool-call JSON, verify the handler gets an `error:` result

---

**Relevant files**

- `packages/core/src/errors.ts` — `Result<T>`, `ViseError` types (the parse error uses `kind: "malformed"`)
- `packages/core/src/todos.ts` — `parseTodos` (to be replaced by schema)
- `packages/core/src/goal-trace.ts` — `GoalTraceFact`/`GoalTraceEntry` types
- `packages/core/src/workflow.ts` — `Workflow`/`WorkflowStep` types
- `packages/core/src/audit.ts` — `AuditEvent` discriminated union
- `packages/backend/src/stores/sessions.ts` + `session-write.ts` — session read/write
- `packages/backend/src/stores/profiles.ts` — `parseProfile`, `parseHookList`
- `packages/backend/src/stores/workflows.ts` — `validateWorkflow`, `validateStep`
- `packages/backend/src/mcp/mcp-config.ts` — `parseServer`, `isRecord`, `isStringMap`
- `packages/backend/src/mcp/mcp-store.ts` — `readFile`, `readEntries`, `saveEntry`
- `packages/backend/src/settings/settings-file.ts` — `parseEnv`, `problem()`, `saveSettings`
- `packages/backend/src/db/audit/audit-store.ts` — `SqliteAuditSink.record/flush/write`
- `packages/backend/src/db/audit/audit-query.ts` — `SqliteAuditReader`, `callOf()`
- `apps/web/src/router/router.ts` — `handleMessage` entry point (line 138)
- `apps/web/src/router/connection.ts` — `WireMessage` interface
- `packages/frontend/src/server-message.ts` — `ServerMessage` flat interface (→ discriminated union)
- `packages/frontend/src/app.ts` — `handleServerMessage` switch (line 418)

**Verification**

1. `bunx tsc --noEmit` — all type checks pass after the refactor (no `any` leaks from `z.infer` or `satisfies` mismatches)
2. `bun test` — full test suite passes; new schema tests cover parse success/failure for every schema
3. `bun run lint` — no unused imports (removed validators), no `@typescript-eslint/no-explicit-any` from zod internals
4. Manual: open the Web UI, edit a profile's tools/hooks, save — verify the `.md` file is correct and reloading shows the right values
5. Manual: open a workflow in the Web editor, save a step with a bad tool name — verify the error message names the field
6. Manual: stop the server mid-write to the audit DB, restart, `/audit` — verify no crash, just a log entry for the dropped row
7. Manual: send a malformed WS message via DevTools (`ws.send('{"type": "line"}')` missing `text`) — verify it's dropped, not a server crash

**Decisions**

- **Zod version:** use the latest stable major. If 4.x introduces breaking changes from 3.x that complicate the API (e.g., `safeParse` signature changes), pin to 3.25.2.
- **Types stay canonical:** hand-written interfaces are NOT replaced by `z.infer` exports. Instead, schemas are annotated to be `ZodType<TheExistingType>`, so the existing imports in every file keep working. This avoids a mass rename across the codebase.
- **Server→page messages:** no zod runtime validation in the frontend. The discriminated union type is the guarantee. Rationale: the server is our own code; adding a zod parse per message on the hot path (token streaming) costs CPU for a risk that's already covered by type checking.
- **Tool-call arguments:** validated at the `ToolRunner` dispatch boundary (where `<|tool_call|>` JSON is parsed), not inside each individual handler. This is a new validation layer (doesn't replace anything).
- **Notes:** no schema. Note bodies are opaque plain text; only the name validation (`validName`) exists and it's a path-traversal guard, not a data-shape validation. Notes are out of scope for zod.
- **Settings `.env` parse:** `parseEnv` (the line-by-line regex) stays as-is — it's a format parser, not a shape validator. The zod schema covers the _value_ validation (no newlines, numeric range), replacing `problem()`.

**Further Considerations**

1. **Error message quality:** the `body` string in `{ kind: "malformed", body }` is what the user sees in `/audit`, the Web UI error toast, or the terminal. Zod's default error messages ("Expected string, received number") are decent but not great. Consider a small `describe`/`error` override on key schemas (e.g., `todo 3 needs a status of pending, in_progress, or completed`) to match the existing hand-rolled messages. Recommendation: do this for the schemas that surface to users (todos, workflow, MCP); keep zod defaults for internal-only schemas (audit rows, internal message fields).

2. **Schema co-location vs. central directory:** the plan puts all schemas in `packages/core/src/schemas/`. An alternative is co-locating each schema next to its type definition (e.g., `workflowSchema` exported from `core/src/workflow.ts` alongside `WorkflowStep`). Co-location keeps the import graph simpler and makes it obvious where a schema lives. Trade-off: the `schemas/` directory is easier to discover as "all our runtime validation". Recommendation: co-locate for now (simpler); move to a directory if the file grows past ~100 lines.

3. **Frontend discriminated union migration:** converting `ServerMessage` from a flat interface to a discriminated union touches every `switch` case in `app.ts` and the panels that handle specific types. This is a mechanical refactor but spans ~10 files in `packages/frontend/src/`. It's independent of the core schemas and can be done as a separate PR after the core schemas land. Recommendation: Phase 3 is a follow-up PR, not blocking Phase 1–2.
