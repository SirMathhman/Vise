## Plan: Consistent Serialization with Zod

Add `zod` as a direct dependency (already present transitively at 4.6.7 via `@modelcontextprotocol/sdk`) and make it the single runtime-validation layer at every trust boundary. Schemas live in `packages/core` (pure JS, no `node:` imports — compatible with core's purity rule). All parse calls return `Result<T>` (the existing `Result` union from `packages/core/src/errors.ts`; a parse failure is `{ kind: "malformed", body: <raw text> }`).

**What it covers (all paths):**
- Disk → code: sessions DB, profiles, workflows, MCP config, settings `.env`, audit DB
- Page → server (WebSocket): all `WireMessage` variants
- Server → page (WebSocket): TypeScript discriminated unions for compile-time safety
- Model output → code: tool-call `arguments` JSON

---

**Phase 0 — Setup**

1. Add `zod` to root `package.json` `dependencies`. Version: `^4.6.7` (already resolved in `bun.lock`; making it a direct dep just declares the intent). No new install needed.
2. Create `packages/core/src/schemas/parse.ts`:
   - `parse<T>(schema: z.ZodType<T>, data: unknown): Result<T>` — calls `schema.safeParse(data)`; on success returns `{ ok: true, value }`, on failure returns `{ ok: false, error: { kind: "malformed", body: <formatted issues> } }`.
   - The `body` string is human-readable: zod's `error.issues` formatted as `"<path>: <message>"` lines joined with `\n`, prefixed with the raw input truncated to ~500 chars.
   - `parseOrThrow` is NOT introduced; every caller gets `Result<T>`.

**Phase 1 — Core schemas (in `packages/core/src/schemas/`)**

Each file is pure (no `node:` imports, no `process`). Hand-written types stay as the canonical exported types; each schema is annotated with a type parameter so TypeScript catches drift (e.g., `z.object({…}) as unknown as z.ZodType<TodoItem[]>`).

| File | Schemas | Replaces | Covers |
|---|---|---|---|
| `todo.ts` | `todoItemSchema`, `todosSchema` | `parseTodos` in `core/src/todos.ts` | Session todos column |
| `message.ts` | `pictureSchema`, `toolCallSchema`, `messageSchema` | none (no existing validator in session read) | Sessions DB `tool_calls`, `images` columns |
| `goal-trace.ts` | `goalTraceFactSchema` (discriminated union on `kind`, 8 variants), `goalTraceEntrySchema` (fact + `at: string` + `after: number`) | the try/catch in `readTrace()` (session-write.ts:97–105) | Sessions DB goal_trace table |
| `workflow.ts` | `workflowStepSchema` (discriminated union: `instruction`/`profile`/`tool`), `workflowSchema` (`{ steps: WorkflowStep[] }`) | `validateWorkflow` + `validateStep` in `backend/src/stores/workflows.ts:152–195` | Workflow `.json` files; Web editor save path |
| `mcp.ts` | `mcpServerSpecSchema` (discriminated: `command` present = stdio, `url` present = remote), `mcpFileSchema` (`{ mcpServers: Record<string, McpServerSpec> }`) | `parseServer`, `isRecord`, `isStringMap` in `backend/src/mcp/mcp-config.ts:28–62` | MCP config `.json` files; Web settings save path |
| `profile.ts` | `profileFrontmatterSchema` (pre-transform: regex split, then per-line parse: `tools?` string, `hooks?` JSON-array-of-strings, rest = meta), `profileFileSchema` (frontmatter + body string) | `parseProfile` in `backend/src/stores/profiles.ts:71–105`, `parseHookList` (line 98) | Profile `.md` files |
| `settings.ts` | `settingValueSchema` (string with no embedded newlines; numeric variant checks `>= min`) | `problem()` in `backend/src/settings/settings-file.ts:41–48` | Settings `.env` file; Web settings save path |
| `audit-event.ts` | `auditEventSchema` (discriminated union on `kind`, ~15 variants matching `AuditEvent` in `core/src/audit.ts`) | none (no existing validator) | Audit DB read-back (for `/audit` display and export) |
| `tool-args.ts` | `toolCallArgsSchema` (object: `name: string`, `arguments: Record<string, unknown>`) | none (currently unchecked) | Model output → tool dispatch |

**Phase 2 — Wire schemas (page→server)**

File: `apps/web/src/router/wire-schemas.ts` (lives with the router, since `WireMessage` is a web-app type, not core).

Define a discriminated union by `type` literal, one schema per message family:
- `line` (text required, qid optional, images optional)
- `steer` (text required)
- `unqueue` (qid required)
- `interrupt`
- `ask_answer` (text required)
- `env_get`, `env_set` (values: Record<string,string>)
- `env_choices`
- `lists_get`
- `hooks_get`
- `profile_tools` (name required, tools optional string[]|null, read optional bool)
- `model_list`, `model_set` (name optional string)
- `note_list`, `note_get`, `note_save`, `note_delete`
- `profile_list`, `profile_get`, `profile_save`, `profile_delete`
- `workflow_list`, `workflow_get`, `workflow_save`, `workflow_delete`
- `mcp_get`, `mcp_save`, `mcp_delete`, `mcp_restart`
- `git_status`, `git_stage`, `git_unstage`, `git_commit`
- `sem_search`, `sem_status`, `sem_rebuild`
- `browser_*` prefix group (pass-through, no validation beyond `type`)
- `term_*` prefix group
- `inspect_start` (request: number)
- `inspect_stop`

The router's `handleMessage` (apps/web/src/router/router.ts:138) replaces its `typeof msg?.type !== "string"` guard with `parse(wireMessageSchema, parsed)`. On failure, log the error and drop the message (same behavior as today for bad payloads).

Existing `typeof` guards inside handlers (`handleLineFamily`: text, qid; `handleSettingsMessage`: values is a Record; etc.) become redundant and are removed — the schema guarantees the shape.

**Phase 3 — Server→page types (compile-time only)**

Refactor `packages/frontend/src/server-message.ts` from the flat 66-field interface to a **discriminated union** by `type` literal. Each variant has only the fields it actually carries.

The frontend's `handleServerMessage` (app.ts:418) switches on the narrowed `type`; each branch gets its fields without optional chains. No zod runtime validation on the frontend — the server builds these messages from trusted code, and the discriminated union is the compile-time guarantee.

The server's `send` function stays `(msg: Record<string, unknown>) => void` (no runtime cost); TypeScript's type checking at the call site ensures the shape.

**Phase 4 — Store integration**

Replace each hand-rolled validator with the corresponding schema + `parse()` call:

1. **Sessions** (`backend/src/stores/session-write.ts` + `sessions.ts`):
   - `storedTodos()` → `parse(todosSchema, JSON.parse(json))` — returns `Result<TodoItem[]>` as before.
   - `readMessages()`: wrap `JSON.parse(r.tool_calls)` in `parse(toolCallSchema.array, …)` and `JSON.parse(r.images)` in `parse(pictureSchema.array, …)`. On failure, drop the field (message is still valid without it) and log.
   - `readTrace()`: replace the try/catch with `parse(goalTraceEntrySchema, entry)`; skip entries that fail (same behavior as today).

2. **Profiles** (`backend/src/stores/profiles.ts`):
   - `parseProfile()` → `parse(profileFileSchema, fileText)`. The schema's pre-transform handles the frontmatter regex. On failure, fall back to `{ body: fileText, meta: [], tools: undefined, hooks: undefined }` (the current fallback for a file without frontmatter).
   - `parseHookList()` is absorbed into the schema and deleted.

3. **Workflows** (`backend/src/stores/workflows.ts`):
   - `loadWorkflow()` → `parse(workflowSchema, JSON.parse(text))`. On failure, return the `Result` error (replacing the current `throw`). `readWorkflowAt` already returns `Result<Workflow>` — just swap the internal call.
   - `saveWorkflowAt()` → `parse(workflowSchema, { steps })` before writing (replacing `validateWorkflow`).

4. **MCP** (`backend/src/mcp/mcp-store.ts` + `mcp-config.ts`):
   - `parseServer()` → `parse(mcpServerSpecSchema, value)`. The `McpServerSpec` type stays hand-written; the schema is typed against it.
   - `readFile()` / `readEntries()`: wrap in `parse(mcpFileSchema, parsed)`. On failure, skip the file (same as today).
   - `saveEntry()`: `parse(mcpServerSpecSchema, entry)` before calling `edit()`.

5. **Settings** (`backend/src/settings/settings-file.ts`):
   - `problem()` → `parse(settingValueSchema, value)` per setting. The schema knows whether the value must be numeric (from the `Spec` definition) and enforces `>= min`.
   - `saveSettings()`: replace the inline `problem()` call with the schema parse. Reject unknown names as before.

6. **Audit** (`backend/src/db/audit/audit-query.ts` + `audit-store.ts`):
   - `callOf()` and similar row-mapping functions: after building the `AuditCall` object from row fields, validate with `parse(auditCallSchema, obj)`. Catches schema drift if a DB migration lagged.
   - Write side (`audit-store.ts`): before `JSON.stringify` of `tool_calls`, guard with `parse(toolCallSchema.array, m.tool_calls)` — prevents a malformed model response from corrupting the DB. On failure, store the raw string as-is (it's text in the DB, not typed).

7. **Tool arguments** (wherever `ToolRunner.run` parses the model's `<|tool_call|>` JSON, in `packages/backend/src/tools/`):
   - After `JSON.parse(argumentsString)`, validate with `parse(toolCallArgsSchema, parsed)` before dispatching to the handler. On failure, return `error: malformed tool arguments for <name>: <zod issues>`. This is a **new** validation layer that doesn't exist today.

**Phase 5 — Cleanup**

Remove the replaced validators and update all import sites:
- `parseTodos` from `core/src/todos.ts` (replaced by `schemas/todo.ts`)
- `validateWorkflow` / `validateStep` from `backend/src/stores/workflows.ts`
- `parseServer` / `isRecord` / `isStringMap` from `backend/src/mcp/mcp-config.ts`
- `parseProfile` / `parseHookList` from `backend/src/stores/profiles.ts`
- `problem()` from `backend/src/settings/settings-file.ts`
- Redundant `typeof` guards in `apps/web/src/router/router.ts` handlers

**Phase 6 — Tests**

For each schema, a test file in `packages/core/test/schemas/`:
- Parse success (valid data in → `Result.ok` with correct value)
- Parse failure (invalid data in → `Result.err` with the right field path in the error body)
- Edge cases: empty arrays, missing optional fields, wrong types, deeply nested bad values

Integration-level tests in `test/`:
- Corrupt a session DB row (bad JSON in `tool_calls`), `loadSession` → message loads without the `tool_calls` field, no crash
- Corrupt a workflow `.json`, `loadWorkflow` → returns `Result.err` (not a throw)
- Send a malformed WS message via the router, verify it's dropped and logged
- Model returns bad tool-call JSON, verify the handler gets an `error:` result

---

**Relevant files**

- `packages/core/src/errors.ts` — `Result<T>`, `ViseError` types (parse error uses `kind: "malformed"`)
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

1. `bunx tsc --noEmit` — all type checks pass after the refactor (no `any` leaks from schema-to-type mismatches)
2. `bun test` — full test suite passes; new schema tests cover parse success/failure for every schema
3. `bun run lint` — no unused imports (removed validators), no `@typescript-eslint/no-explicit-any` from zod internals
4. Manual: open the Web UI, edit a profile's tools/hooks, save — verify the `.md` file is correct and reloading shows the right values
5. Manual: open a workflow in the Web editor, save a step with a bad tool name — verify the error message names the field
6. Manual: stop the server mid-write to the audit DB, restart, `/audit` — verify no crash, just a log entry for the dropped row
7. Manual: send a malformed WS message via DevTools (`ws.send('{"type": "line"}')` missing `text`) — verify it's dropped, not a server crash

**Decisions**

- **Zod version:** `^4.6.7` — already resolved in `bun.lock` as a transitive dep of `@modelcontextprotocol/sdk`. Adding it as a direct dep just makes the intent explicit. No new install.
- **Types stay canonical:** hand-written interfaces (`Message`, `ToolCall`, `Picture`, `TodoItem`, `WorkflowStep`, `McpServerSpec`, etc.) are NOT replaced by `z.infer` exports. Schemas are typed against the existing interfaces (via a type parameter or a `satisfies` assertion), so existing imports in every file keep working. This avoids a mass rename across the codebase.
- **Server→page messages:** no zod runtime validation in the frontend. The discriminated union type is the guarantee. Rationale: the server is our own code; adding a zod parse per message on the hot path (token streaming) costs CPU for a risk already covered by type checking.
- **Tool-call arguments:** validated at the `ToolRunner` dispatch boundary (where `<|tool_call|>` JSON is parsed), not inside each individual handler. This is a **new** validation layer (doesn't replace anything).
- **Notes:** no schema. Note bodies are opaque plain text; only the name validation (`validName`) exists and it's a path-traversal guard, not a data-shape validation. Notes are out of scope for zod.
- **Settings `.env` format parse:** `parseEnv` (the line-by-line regex) stays as-is — it's a format parser, not a shape validator. The zod schema covers *value* validation (no newlines, numeric range), replacing `problem()`.
- **Error messages:** for schemas that surface to users (todos, workflow, MCP, settings), use zod's `error` override to match the existing hand-rolled messages (e.g., `"todo 3 needs a status of pending, in_progress, or completed"`). For internal-only schemas (audit rows, internal wire fields), keep zod's default messages.

**Further Considerations**

1. **Schema co-location vs. central directory:** the plan puts schemas in `packages/core/src/schemas/`. An alternative is co-locating each schema next to its type (e.g., `workflowSchema` exported from `core/src/workflow.ts`). Co-location keeps the import graph simpler. Trade-off: the `schemas/` directory is easier to discover as "all our runtime validation". Recommendation: central directory for now (clearer separation of concerns; core files stay focused on types + logic, not validation).

2. **Frontend discriminated union migration (Phase 3):** converting `ServerMessage` from a flat interface to a discriminated union touches every `switch` case in `app.ts` and the panels that handle specific types (~10 files in `packages/frontend/src/`). It's a mechanical refactor but independent of Phases 1–2. Recommendation: Phase 3 is a follow-up PR after the core schemas land.

3. **`Result<T>` vs. throwing in core:** `parseTodos` already returns `Result<T>` and `loadWorkflow` throws — the codebase is inconsistent. After this migration, the direction is clear: every parse boundary returns `Result<T>`. Functions that currently throw on parse (e.g., `loadWorkflow` in the non-editor path) should be updated to return `Result<T>` and their callers adjusted. This is a small behavioral change (a throw becomes a `Result.err`) but the only callers are the store functions themselves and the `/workflow` command handler.
