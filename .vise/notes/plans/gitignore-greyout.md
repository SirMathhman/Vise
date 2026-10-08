## Plan: Grey Out Gitignored Files in File Explorer

When the session root is a git repository, grey out (dim) entries in the web file explorer that are ignored by `.gitignore` rules. Entries remain visible and clickable.

**Approach:** Server-side, after listing a directory, run `git check-ignore --stdin` (one fast call per listing) to determine which entries are ignored. Add an `ignored: boolean` field to each `DirEntry`. The client renders a CSS class on ignored rows.

**Steps**

### Phase 1 — Server: extend DirEntry and annotate git-ignored status

1. **`src/web/files.ts`** — extend `DirEntry` interface (line 16-19) with an optional field `ignored?: boolean`. No other changes to `listDir()` itself.

2. **`src/web/files.ts`** (or a small new helper in the same file) — add `isGitRoot(root: string): boolean` that checks `existsSync(join(root, ".git"))` (covers both `.git` directories and `.git` files used by submodules/worktrees). Cache the result per root (a module-level `Map<string, boolean>` or just compute it once and store on the root string in a closure — the server process lives for one root per connection, so even a plain `let` cached by root path is fine).

3. **`src/web/files.ts`** — add `annotateIgnored(root: string, rel: string, entries: DirEntry[]): DirEntry[]` that:
   - Returns `entries` unchanged if `isGitRoot(root)` is false.
   - Builds the list of paths relative to root: for each entry, `rel ? rel + "/" + entry.name : entry.name` (on Windows use the platform separator, or just `/` which git accepts on all platforms).
   - Runs `git check-ignore --stdin` with `cwd = root`, piping the paths (one per line) to stdin, using `Bun.spawnSync` (synchronous, matching the existing `readdirSync`/`realpathSync` pattern in the file). Git is fast (sub-10 ms for a handful of paths).
   - Parses stdout (one ignored path per line) and marks matching entries with `ignored: true`.
   - If the git process fails (git not installed, not a repo after all, etc.), returns `entries` unchanged (graceful degradation).

4. **`src/web/server.ts`** — in `serveExplorer()` (line ~85), after the `listDir` call succeeds, if the request was `/api/fs`, call `annotateIgnored(root, rel, result.value.entries)` and replace `result.value.entries` with the annotated result before `Response.json(...)`.

### Phase 2 — Client: render the grey-out

5. **`web/src/explorer.ts`** — in `fileRow()` (line ~290) and `dirRow()` (line ~310), when constructing the `<li>`, check if the entry data has `ignored === true` and add a CSS class (e.g., `fs-ignored`) to the row element. The entry data comes from the JSON response in `fetchEntries` — the existing code reads `entry.name` and `entry.dir`; it already has the full entry object available. Add `entry.ignored` to the check.

6. **`web/styles.css`** — add a rule:
   `.fs-row.fs-ignored { opacity: 0.4; }`
   This dims the row (icon + text) while keeping it visible and clickable. No hover/interaction changes needed.

### Phase 3 — Verification

7. **`bunx tsc --noEmit`** — type-check passes.
8. **`bun run lint`** — lint passes.
9. **Manual test:** open a git repo folder in the web UI with a `.gitignore` that excludes e.g. `*.log` or `node_modules/`. Verify that matching files/dirs appear dimmed. Click a dimmed file — it should open normally. Toggle a file's ignore status (edit `.gitignore`) — the watcher fires `fs_changed` → `reload()` → the tree re-fetches and the grey-out updates.

**Relevant files**

- `src/web/files.ts` — `DirEntry` interface (line 16-19), `listDir()` (line 43-59), `confine()` (line 30-41), `watchRoot()` (line 88-110). Add `isGitRoot` and `annotateIgnored` here or in a small helper module.
- `src/web/server.ts` — `serveExplorer()` (line ~85-98). Modify to call `annotateIgnored` after `listDir`.
- `web/src/explorer.ts` — `fileRow()` (line ~290), `dirRow()` (line ~310), `fetchEntries()`. Add `fs-ignored` class based on `entry.ignored`.
- `web/styles.css` — add `.fs-row.fs-ignored` rule.

**Verification**

1. `bunx tsc --noEmit` — no type errors.
2. `bun run lint` — no lint errors.
3. Open a git repo with a `.gitignore` (e.g., one that ignores `*.log` and `build/`). Verify in the web file explorer: `foo.log` and `build/` appear dimmed, other files do not. Click a dimmed file — it opens. Edit `.gitignore` to un-ignore a file — after a moment (watcher fires), the file is no longer dimmed.
4. Open a non-git folder — no grey-out, no git calls (verify with a slow git or by checking that it still works with git not on PATH).
5. `bun test` — existing tests pass (the change is additive; no core logic touched).

**Decisions**

- **Method:** `git check-ignore --stdin` — accurate (handles nested `.gitignore`, negations, git config, `core.excludesFile`), one fast call per listing, no parsing of glob patterns needed.
- **Scope:** folder sessions only (`isGitRoot` returns false for no-folder roots, so no git calls are made).
- **Visibility:** dimmed (opacity 0.4), not hidden — entries remain clickable and openable.
- **Sync I/O:** `Bun.spawnSync` for the git call, consistent with the existing `readdirSync`/`realpathSync` pattern in `listDir`. Git is fast; the endpoint is not latency-critical.
- **Graceful degradation:** if git is missing or fails, entries are returned un-annotated (no `ignored` flag → no grey-out). No error surfaced to the user.
- **Caching:** `isGitRoot` result cached per root (computed once). The `git check-ignore` call itself is not cached (it must reflect current `.gitignore` state; the watcher's `reload()` re-fetches listings after changes).

**Further Considerations**

1. If performance ever becomes an issue with very large directories (hundreds of entries), the `git check-ignore --stdin` call could be batched across multiple directory listings, or the ignored set could be cached with a short TTL invalidated by the watcher. For now, one call per listing is simplest and sufficient.
2. A future enhancement could also show untracked files differently (e.g., a dot prefix), but that is out of scope here.
