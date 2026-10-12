> **Status:** implemented (see AGENTS.md, "Semantic search"). Differences from this plan: embeddings are always local
> (`LlmClient.embedMany`, never the chat provider); the table also keeps line ranges, the model and mtime; the
> explorer search goes over the WebSocket (`sem_*`), not HTTP; the tool is registered in `ioHandlers` in wiring.

## Plan: Semantic Search for File Content

Add semantic (embedding-based) search across file content in the working directory. Indexed in the background when a folder opens; queried via a `/search semantic <text>` command, a `semantic_search` model-facing tool, and a search box in the web file explorer. Results show file path + snippet + relevance score.

**Why:** The existing `search_files` tool and `/search` command are exact/regex. Semantic search finds content by meaning — "how does auth work" should find the auth module even if it doesn't contain the word "auth." Useful for codebases where naming is inconsistent or for natural-language queries.

**Key decisions (from discussion):**
- Separate command (`/search semantic <text>`), not a replacement for `/search`
- All files in the working directory (skip `node_modules`, `.git`, binary files, files > 1 MB)
- Fixed-size windows for chunking (~50 lines or ~2 KB, whichever is shorter, with ~10-line overlap)
- Indexed in the background when the folder opens; re-runnable via `/embed`
- Embedding model: same llama.cpp server, same model name by default (overridable via `VISE_EMBEDDING_MODEL`)
- Cosine similarity computed in JS over embeddings stored as BLOBs in the project's `.vise/vise.db`
- Both model-facing tool (`semantic_search`) and user command
- Web: search box at the top of the file explorer tree

---

**Phase 1: Embedding Infrastructure**

1. **Add `embed` method to `LlmClient`** — `src/client/llm.ts`
   - New async method: `async embed(text: string, model?: string): Promise<number[]>`
   - For llama.cpp: `POST ${provider.rootUrl}/v1/embeddings` with `{ model, input: [text] }` → response `{ data: [{ embedding: number[] }] }` → return `data[0].embedding`
   - Embeddings always use the local server's `/v1/embeddings`; no hosted embedder is supported.
   - Error handling: return a `ViseError`-like structured error (network, 404, etc.) — follow the pattern of `listModels()` (line 319) and `supportsVision()` (line 287)
   - The model name defaults to `config.llmModel` but is overridable by a new config key
   - **Parallel with step 2**

2. **Add config setting for embedding model** — `src/config.ts`
   - Add to `SPEC`: `embeddingModel` — inline `Spec` literal, env `VISE_EMBEDDING_MODEL`, def same as `llmModel`'s default (`"local"`), group `LLM`, label `Embedding model`
   - Add to `.env.example`
   - **Parallel with step 1**

3. **Create the file-embeddings store** — `src/stores/file-embeddings.ts` (new)
   - SQLite table (new migration in `src/db/session/session-schema.ts` or a new `src/db/file-embeddings-schema.ts`):
     ```
     CREATE TABLE file_embeddings (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       file_path TEXT NOT NULL,
       chunk_index INTEGER NOT NULL,
       content TEXT NOT NULL,
       embedding BLOB NOT NULL,
       dims INTEGER NOT NULL,
       indexed_at TEXT NOT NULL,
       UNIQUE(file_path, chunk_index)
     );
     CREATE INDEX file_embeddings_path ON file_embeddings(file_path);
     ```
   - Functions:
     - `indexFile(db, filePath, chunks: { start, end, content }[], embedding: number[][], model: string)`: upserts all chunks for a file (deletes old rows for that path, inserts new). Stores embedding as a `Float32Array` BLOB.
     - `deleteFile(db, filePath)`: removes all chunks for a path (called when a file is deleted or renamed)
     - `searchEmbeddings(db, queryEmbedding: number[], dims: number, limit: number)`: loads all embeddings (file_path, chunk_index, content, embedding) into memory, computes cosine similarity for each, returns top `limit` results as `{ filePath, chunkIndex, content, score }[]` sorted by score descending
     - `clearAll(db)`: wipes the table (for `/embed` re-index)
   - **Depends on step 1** (needs the embedding shape)

4. **File walker + chunker** — `src/stores/file-embeddings.ts` (or a separate `src/stores/chunk.ts` if the file gets long)
   - `walkAndChunk(root: string, maxBytes: number): AsyncIterable<{ filePath, relativePath, chunks: { start, end, content }[] }>`
   - Walk: recursive directory walk from `root`, skipping `node_modules`, `.git`, `.vise`, hidden directories, symlinks. Skip files > `maxBytes` (config, default 1 MB). Detect binary by checking for NUL bytes in the first 8 KB (same heuristic as `readTextFile` in `src/web/api/files.ts` line 72).
   - Chunk: read file as UTF-8 string, split into lines. Window size = min(50 lines, 2000 chars). Overlap = 10 lines. Emit chunks as `{ start: lineStart, end: lineEnd, content }`. Skip empty chunks.
   - **Depends on step 3** (the `chunks` shape)

5. **Background indexing runner** — `src/stores/file-embeddings.ts` (or `src/repl/embed/index.ts`)
   - `indexRoot(root: string, client: LlmClient, dataDir: string, signal: AbortSignal): Promise<{ indexed: number, skipped: number }>`
   - Iterates `walkAndChunk`, calls `client.embed(chunk.content)` for each chunk, stores via `indexFile`. Processes files sequentially (or 2-3 in parallel) to not saturate the LLM server.
   - Respects `AbortSignal` (stops if the session is torn down).
   - Skips files whose `indexed_at` is newer than the file's `mtime` (incremental: only re-embed changed files). For the first run, everything is new.
   - **Depends on steps 3, 4, 1**

---

**Phase 2: User-Facing Surfaces**

6. **`/search semantic <text>` command** — `src/repl/commands/search-command.ts` (extend existing file)
   - Add a second handler: `handleSemanticSearchCommand(session: SessionCommands, line: string): Promise<Result<string>>`
   - Parses: `/search semantic <text>` → extracts `<text>`
   - Calls a port method: `session.embeddingsSearch?(text)` — a new optional method on `SessionCommands` (ports.ts), implemented as a closure in `Session` that calls into the embedding store
   - Formats results: `formatSemanticHits(hits)` — similar to `formatSearchHits` (line 122 of `src/output/audit-format.ts`): shows `  <relative-path>  (chunk N, score 0.87): <snippet clipped to 80 chars>`
   - If no embeddings are indexed yet: returns a helpful message ("no files indexed yet — open the folder to index, or run /embed")
   - Register in the commands table (`src/repl/session.ts` line 437-458): a new entry `{ name: "/search", run: ... }` that dispatches: if the argument starts with `semantic `, delegate to `handleSemanticSearchCommand`; otherwise, existing `handleSearchCommand`.
   - **Depends on Phase 1 complete**

7. **`/embed` command** — `src/repl/commands/embed-command.ts` (new)
   - Triggers a full re-index of the current root: clears the embeddings table, runs `indexRoot`
   - Shows progress ("Indexing 42 files… done: 38 indexed, 4 skipped")
   - If no root (no-folder session): returns "no folder to index"
   - Register in the commands table alongside the other commands
   - **Depends on Phase 1 complete**

8. **Auto-index on session open** — `src/wiring.ts`
   - In `createEdgeSession`, after the session is constructed, kick off `indexRoot(root, client, dataDir, signal)` in the background (fire-and-forget with a `.catch` that logs to the audit log).
   - Only if the root exists and is a directory (not no-folder).
   - The signal comes from the session's per-turn abort or a session-level abort controller.
   - This is non-blocking: the session is ready immediately; indexing happens behind the scenes.
   - **Depends on Phase 1 complete**

---

**Phase 3: Model-Facing Tool**

9. **`semantic_search` tool definition** — `src/tools/defs/files.ts` (add to `fileTools` array)
   - `name: "semantic_search"`
   - `display: { label: "Semantic Search", icon: "🔍" }` (or a different icon to distinguish from `search_files`)
   - `parameters`: `{ query: string (required), limit?: number (default 5, max 10) }`
   - `description`: "Search file contents by meaning (semantic similarity). Finds files whose content is conceptually related to the query, even if they don't contain the exact words. Returns file path, a snippet of the most relevant chunk, and a relevance score. Use when exact keyword search (search_files) doesn't find what you need, or when you're unsure of the exact terminology."
   - Add `requiresFileSystem: true` (it's in the `files` category, so it gets the flag via `needsFileSystem`)
   - **Not a core tool** — it's deferred (the model finds it via `search_tools`). The description is clear enough that the model will use it when appropriate.
   - **Depends on Phase 1 complete**

10. **`semantic_search` tool handler** — `src/tools/files.ts` (or a new `src/tools/semantic-search.ts` if `files.ts` is getting long)
    - `semanticSearch(args: Record<string, unknown>, store: FileEmbeddingsStore): string`
    - Parses `query` (required) and `limit` (optional, default 5)
    - Calls `client.embed(query)` to get the query embedding
    - Calls `store.searchEmbeddings(queryEmbedding, dims, limit)`
    - Formats results: `<relative-path>  (score 0.87): <first 120 chars of chunk content>\n` per hit
    - If zero results: `"no semantic matches for '<query>'"`
    - If no index exists: `"no files indexed yet (run /embed)"`
    - Register in `baseHandlers` (`src/tools.ts` line 132): `semantic_search: (args) => semanticSearch(args, embeddingsStore)` — needs the store passed in, so it's slightly different from the other file handlers. The store is per-root, like the session DB. This means `baseHandlers` needs an additional parameter (the embeddings store), or the handler is registered as an `extra` handler in `createToolRunner` (the pattern used for subagent/ask_user handlers).
    - **Decision:** register as an `extra` handler in `createToolRunner`'s call site in `wiring.ts` (the store depends on the root's DB, constructed later). Same pattern as `run_subagent`.
    - **Depends on step 9, Phase 1**

---

**Phase 4: Web UI**

11. **Web API message for semantic search** — `src/web/api/files.ts` (extend) or new `src/web/api/semantic-search-api.ts`
    - New message type: `fs_semantic_search` with `{ query: string, limit?: number }`
    - Handler: `handleSemanticSearchMessage(msg, root, store, client)` — embeds the query, searches, returns `[{ type: "fs_semantic_results", hits: [...] }]`
    - Each hit: `{ path: string, chunkIndex: number, snippet: string, score: number }`
    - Route in `src/web/server.ts` dispatcher (alongside the other `/api/fs` handlers, or as a WS message if it's more natural as a per-connection message)
    - Actually: since the file explorer already uses HTTP (`/api/fs`, `/api/file`), the semantic search should also be HTTP: `GET /api/fs-search?q=<query>&root=<root>` → `{ hits: [...] }`. This keeps it consistent with the explorer's existing fetch pattern.
    - **Depends on Phase 1 complete**

12. **Search box in the file explorer** — `web/src/workspace/explorer.ts`
    - Add a `<input type="search" class="field" placeholder="Search files…">` above the tree (between `#files-path` and `#files-list`, or replacing `#files-path` when searching)
    - On input (debounced ~300 ms): `fetch(/api/fs-search?q=...&root=...)` → render results as a list replacing the tree (or in an overlay)
    - Each result row: relative path + score badge + snippet. Click opens the file at the chunk's start line (via `openFile` with an offset).
    - When the input is cleared, restore the tree view.
    - **Depends on step 11**

---

**Phase 5: Polish & Edge Cases**

13. **Incremental indexing on file changes** (optional, nice-to-have)
    - The existing `watchRoot` in `src/web/api/files.ts` (line 248) already watches for file changes and sends `fs_changed` messages. Extend it: when a file changes, re-embed just that file's chunks (call `deleteFile` + `indexFile` for that path only).
    - This makes the index stay fresh without a full re-index.
    - **Depends on Phase 1, Phase 4**

14. **`/embed` status in the terminal** — while indexing is in progress, `/embed` shows progress ("12/42 files done"). If indexing is already running, a second `/embed` waits or reports "already indexing."
    - **Depends on step 7**

15. **Audit log integration** — log the indexing run (files indexed, files skipped, duration) and each semantic search query (query text, top hit, score) to the audit log. Follow the `AuditSink` pattern (`src/core/audit.ts`).
    - **Depends on Phase 1**

---

**Relevant files**

- `src/client/llm.ts` — add `embed()` method (follow `listModels`/`supportsVision` pattern)
- `src/config.ts` — add `embeddingModel` setting to `SPEC`
- `src/stores/file-embeddings.ts` — **new**: SQLite store, walker, chunker, indexing runner, search
- `src/db/session/session-schema.ts` — add migration for `file_embeddings` table
- `src/repl/commands/search-command.ts` — add `handleSemanticSearchCommand`, extend dispatch
- `src/repl/commands/embed-command.ts` — **new**: `/embed` handler
- `src/repl/session.ts` — register new command entries (lines 437-458)
- `src/repl/ports.ts` — add `embeddingsSearch?` to `SessionCommands`
- `src/tools/defs/files.ts` — add `semantic_search` tool definition
- `src/tools/files.ts` — add `semanticSearch` handler (or new `src/tools/semantic-search.ts`)
- `src/tools.ts` — register handler (as `extra` in `createToolRunner` or in `baseHandlers`)
- `src/wiring.ts` — kick off background indexing in `createEdgeSession`, pass store to tool runner
- `src/web/server.ts` — route `/api/fs-search` (or WS message)
- `src/web/api/files.ts` — or new `src/web/api/semantic-search-api.ts` for the search handler
- `web/src/workspace/explorer.ts` — add search input + results rendering
- `web/index.html` — add the search input element (or it's created dynamically by `explorer.ts`)
- `.env.example` — add `VISE_EMBEDDING_MODEL`

**Verification**

1. **Unit tests** (`bun test`):
   - `test/stores/file-embeddings.test.ts`: chunking (correct window sizes, overlap, edge cases: empty file, single line, exactly-at-limit file); cosine similarity (known vectors → expected scores); incremental (re-index a changed file, unchanged files skipped); binary detection
   - `test/client/embed.test.ts`: mock the HTTP response, verify `embed()` parses the embedding correctly; verify error on 404/network failure
   - `test/repl/semantic-search-command.test.ts`: mock the store, verify `/search semantic <text>` formats hits correctly, handles empty results, handles "no index yet"
   - `test/tools/semantic-search-tool.test.ts`: mock the store + client, verify the tool returns formatted results, handles missing query parameter
2. **Type-check:** `bunx tsc --noEmit` (server/core) and `bun run typecheck:web` (browser)
3. **Lint:** `bun run lint`
4. **Manual test (terminal):**
   - Start `bun run index.ts` in a project with ~10 text files
   - Wait for background indexing (check audit log or `/embed` status)
   - Run `/search semantic "error handling"` — verify it finds files with error-related content even if they don't contain "error handling" verbatim
   - Run `/search semantic "database connection"` — verify it finds DB-related files
   - Run `/embed` — verify re-index works
   - Compare with `/search <exact phrase>` — verify FTS still works independently
5. **Manual test (model-facing tool):**
   - In a conversation, ask the model to "find the file that handles user authentication" — verify it calls `semantic_search` (not just `search_files`) and gets relevant results
   - Ask "find the configuration for the retry logic" — verify it finds the right file even if it's named something unexpected
6. **Manual test (web UI):**
   - Open the file explorer (Ctrl+B), type a semantic query in the search box
   - Verify results appear with file paths, snippets, and scores
   - Click a result — verify the file opens at the correct location
   - Clear the search — verify the tree restores
7. **No-folder session:** verify `semantic_search` returns "no folder to index" and `/search semantic` gives a helpful message
8. **Performance:** with ~200 files / ~1000 chunks, verify search returns in < 100 ms (cosine similarity over 1000 vectors of 384-768 dims is trivial)

**Decisions**

- Cosine similarity in JS (not a vector DB extension) — for the expected scale (hundreds to a few thousand chunks per project), this is fast and dependency-free. The BLOB storage in SQLite is enough; no need for `sqlite-vec` or a separate vector store.
- Embeddings stored in the project's `.vise/vise.db` (same DB as sessions) — consistent with how all per-project state lives. The table is independent of sessions; it's cleared by `/embed` but survives across sessions.
- The `semantic_search` tool is **deferred** (not in `CORE_TOOLS`) — it's a specialized tool the model should reach for when exact search isn't enough. Keeping `CORE_TOOLS` small keeps the always-visible prompt lean.
- Chunking is fixed-size windows (50 lines / 2 KB, 10-line overlap) — language-agnostic, simple, and works well for both code and prose. No paragraph detection, no AST parsing.
- No hybrid search (no combining with FTS) in this iteration — `/search` (FTS) and `/search semantic` are separate. A future iteration could merge them.
- The embedding model is configurable but defaults to the chat model name — works out of the box if the llama.cpp server supports embeddings for the loaded model; the user can point it at a dedicated embedding model (e.g. `all-MiniLM-L6-v2` or `nomic-embed`).
- Background indexing is fire-and-forget: it doesn't block the session, doesn't show progress in the main flow (only via `/embed` or the audit log). The first semantic search before indexing finishes returns "indexing in progress" or just returns the partial results available so far.
- `node_modules`, `.git`, `.vise`, and hidden directories are skipped. Files > 1 MB are skipped. Binary files (NUL bytes in first 8 KB) are skipped.

**Further Considerations**

1. **Hybrid search:** a future iteration could run both FTS and semantic search and merge results (FTS for exact keyword hits, semantic for conceptual matches). The current plan keeps them separate for simplicity. Recommendation: revisit once the basic version is working and users find they need both.

2. **Cross-project / global search:** currently each project indexes its own files. A future iteration could support searching across multiple projects (a global index or a multi-root search). Recommendation: defer until per-project search is proven useful.

3. **Embedding model dimension changes:** if the user switches embedding models (e.g. from a 384-dim to a 768-dim model), the stored embeddings become incompatible. The `dims` column in the table detects this: if the stored dims differ from the current model's output, all chunks need re-embedding. Recommendation: on `/embed`, always clear and re-index. On auto-index, if dims mismatch, skip (the user will get "no index yet" until they run `/embed`).
