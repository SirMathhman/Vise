## Plan: Git Status Colors in File Explorer

Add colors to the web file tree for files modified since the last commit: yellow for modified/staged/deleted/renamed, green for untracked (new). Matches the existing git panel color tokens.

**TL;DR**: Annotate each directory listing's entries with a git status code (reusing the `annotateIgnored` pattern in `src/web/api/files.ts`), tag the `DirEntry` type with an optional `status` field, apply CSS classes in the explorer client (`web/src/workspace/explorer.ts`), and add color rules to `web/styles/workspace.css`. Refresh is already fs-watched (debounced 150 ms), so colors update automatically.

**Steps**

### Phase 1: Server — annotate entries with git status

1. **Extend `DirEntry` type** in `src/web/api/files.ts` (line 23): add `status?: "M" | "A" | "D" | "R" | "C" | "U" | "?"` field. The existing `ignored?: boolean` is the precedent for per-entry optional data.

2. **Add `annotateGitStatus(root, rel, entries)` function** in `src/web/api/files.ts`, modeled on `annotateIgnored` (line 156):
   - Guard: if `!isGitRoot(root)` → return (no-op, same pattern as `annotateIgnored`).
   - Run `git status --porcelain=v1 -z -uall` via `spawnSync` (the existing `git()` helper at line 85 in `git-api.ts` is a reference for flags; `files.ts` already has its own `git()` — check if it exists or reuse from `git-api.ts` if exported; if not, add a minimal `spawnSync("git", [...])` wrapper).
   - Parse the NUL-separated output: each entry is `XY <path>\0`. Build a `Map<string, string>` where key = repo-relative path, value = the **worktree** status letter (`Y` field), except for `??` entries where the value is `"?"`.
   - For each entry in the directory listing, compute its repo-relative path: `rel ? rel + "/" + entry.name : entry.name`, look up in the map, and set `entry.status` to the code if found.
   - A file that is both staged AND modified (partially staged) appears in both `staged` and `changed` arrays in `parseStatus` — for our purposes we only care about the worktree state (`Y` field), so it will be `M` (or `D`, `R`, etc.). We don't need the staged state separately since the user said "doesn't matter" whether it's staged.

3. **Call `annotateGitStatus` in `serveExplorer`** (`src/web/http.ts`, line 32 area, alongside the existing `annotateIgnored` call):
   - After `annotateIgnored(root, rel, entries)`, add `annotateGitStatus(root, rel, entries)`.
   - The response JSON will now include `status` on modified/new entries.

**Note on performance**: `git status --porcelain=v1 -z -uall` scans the working tree. For large repos this could be 100–500 ms. The existing `annotateIgnored` already runs `git check-ignore --stdin` per request (lighter), so adding a git status call is a modest increase. The fs-watch debounce (150 ms) and the fact that the client only requests directories it displays (lazy expand) keep the total cost manageable. If it becomes a problem, a per-root cache invalidated by `fs_changed` is the follow-up — not in this plan.

### Phase 2: Client — render status classes

4. **Extend the client-side `DirEntry` type** in `web/src/workspace/explorer.ts` (line 16): add `status?: string` to match the server type.

5. **Apply class in `fileRow`** (`explorer.ts` line 289):
   - After the existing `if (ignored) item.classList.add("fs-ignored")` (line 301), add:
     - `if (entry.status === "?") item.classList.add("fs-new")`
     - `else if (entry.status) item.classList.add("fs-modified")`
   - The `fs-modified` class covers M, D, R, C, U, T codes (anything that isn't `?`).

6. **Apply class in `dirRow`** (`explorer.ts` line 313):
   - After the existing `if (ignored) ... add("fs-ignored")` (line 325), add the same two class checks.
   - Directories themselves don't appear in `git status` output (git tracks files, not directories), so a directory won't get a status directly. However, a directory could be marked if it **contains** modified files. **Decision**: keep it simple — only files get colored. Directories stay uncolored. This is what most file explorers do (VS Code colors files, not folders).

7. **Add CSS rules** in `web/styles/workspace.css`, next to `.fs-row.fs-ignored` (line 70):
   - `.fs-row.fs-modified { color: var(--goal-warn); }` — yellow, matches git panel modified
   - `.fs-row.fs-new { color: var(--user); }` — green, matches git panel untracked
   - These use the existing color tokens from `tokens.css` (no new tokens needed). The tokens already have per-theme overrides, so all themes get correct colors automatically.
   - **Precedence**: `.fs-ignored` (opacity 0.45) and `.fs-modified`/`.fs-new` can coexist (a modified file can also be git-ignored — though that's unusual; if both apply, the dimmed opacity + colored text is acceptable). If needed, add a combined rule `.fs-row.fs-ignored.fs-modified { opacity: 0.45; color: var(--goal-warn); }` — but likely not necessary since git-ignored files typically don't show up in `git status --porcelain` (untracked-but-ignored files do appear with `??` under `-uall`). **Decision**: don't add a combined rule; let both classes apply naturally. The dimmed + colored look is informative.

### Phase 3: Verification

8. **Manual verification**:
   - Open a git repo folder in the web UI (e.g., this Vise repo).
   - Modify a tracked file (e.g., edit a `.ts` file without committing). The file tree should show it in yellow.
   - Create a new untracked file. It should appear in green.
   - `git add` a modified file (stage it). It should stay yellow (worktree is still different from HEAD, or if fully staged and clean, it disappears from `git status` — which is correct: no diff from last commit... wait, staged but not committed IS a diff from last commit). **Clarification**: `git status --porcelain` shows staged files with `M ` (index modified, worktree clean) — the `Y` field is `M` when the worktree matches the index but the index differs from HEAD. Actually no: for a fully staged file, `X=M, Y= ` (space) — the worktree state is space because the worktree matches the index. So a fully-staged file would NOT get a `Y` field status. **This is a problem**: the user said "staged or not staged, doesn't matter" — they want staged files colored too.
   - **Fix**: check BOTH the index state (`X` field) AND the worktree state (`Y` field). If either is non-space (and not `?`), the file has a status. For `??` entries, both X and Y are `?`, so those are untracked.
   - Revised rule: if X or Y is `?` → `"?"` (new). Otherwise if X or Y is any of `M`, `A`, `D`, `R`, `C`, `U`, `T` → that letter (prefer the worktree letter if both are set, since that's what the user sees).
   - Test: `git add` a file, verify it still shows yellow.
   - Test: `git add` a new file (it becomes staged, `A ` in porcelain). It should turn from green to yellow (it's now "added" = staged, not untracked). This is correct behavior.
   - Verify the fs watch triggers a refresh: touch a file in the repo, wait ~200 ms, confirm the tree updates without a manual reload.
   - Verify no-folder sessions and non-git folders: no status colors appear (guard returns early).

9. **Automated verification**:
   - Existing tests in `test/` don't cover the file tree (it's web-only, no server test for `/api/fs` git annotation yet). **Add a test**: `test/web/files-git-status.test.ts` (or extend an existing `test/web/*.test.ts` if one covers `/api/fs`):
     - Set up a temp directory with a `.git` (run `git init` + commit a file + modify it + create an untracked file).
     - Call the `serveExplorer` logic (or `listDir` + `annotateGitStatus` directly) and assert the returned entries have the correct `status` fields.
   - Run `bunx tsc --noEmit` and `bunx tsc -p web/tsconfig.json` for type checking.
   - Run `bun test` for the full suite.

**Relevant files**

- `src/web/api/files.ts` — `DirEntry` (line 23), `listDir` (line 51), `annotateIgnored` (line 156), `isGitRoot` (line 111), `serveExplorer` call site. **Modify**: add `status` field, add `annotateGitStatus` function.
- `src/web/http.ts` — `serveExplorer` (line 19). **Modify**: call `annotateGitStatus` after `annotateIgnored`.
- `web/src/workspace/explorer.ts` — `DirEntry` (line 16), `fileRow` (line 289), `dirRow` (line 313). **Modify**: add `status` to type, add class toggling.
- `web/styles/workspace.css` — near `.fs-row.fs-ignored` (line 70). **Modify**: add `.fs-row.fs-modified` and `.fs-row.fs-new` rules.
- `src/web/api/git-api.ts` — reference for `parseStatus`, `git()` helper pattern, `GitFile` type (line 18). **Read-only** (do not modify; the file tree has its own lighter parsing).
- `web/src/git/git-panel.ts` — reference for `CODE_NAMES` (line 24) and class-building pattern (line 68). **Read-only**.

**Verification**

1. `bunx tsc --noEmit` — server/core types pass.
2. `bunx tsc -p web/tsconfig.json` — browser types pass.
3. `bun test` — full test suite passes (including the new git-status annotation test).
4. Manual: `bun run web`, open a git folder, modify a file → yellow, create new file → green, `git add` → stays yellow, `git reset HEAD` → back to yellow (unstaged modified), `git checkout -- <file>` → no color.
5. Manual: non-git folder → no colors. No-folder session → no colors.

**Decisions**

- **Only files are colored, not directories.** Git tracks files; a directory containing modified files is not itself modified. VS Code and similar explorers color files only.
- **Two colors, matching the git panel tokens**: `--goal-warn` (yellow) for modified/staged/deleted/renamed, `--user` (green) for untracked/new. No new CSS tokens.
- **A file that is both staged and unstaged** (partially staged edit): colored yellow (modified). The worktree letter takes precedence over the index letter.
- **A newly staged file** (`git add new.txt`): turns yellow (it's now `A` in the index, no longer `??`). This is correct — it's no longer "new/untracked", it's "added/staged".
- **Git-ignored files**: can appear as `??` in `git status -uall` (untracked but not ignored) — wait, `-uall` shows all untracked including ignored ones? No: `-uall` shows all untracked files **including** those that are ignored. `-unormal` (default) shows untracked but not ignored. Actually, `git status --porcelain -uall` does include ignored untracked files. Hmm, let me reconsider: `annotateIgnored` marks files that git ignores. A file that is both untracked AND git-ignored would get `ignored: true` (dimmed) AND `status: "?"` (green). The dimming + green is acceptable. Alternatively, we could skip annotating ignored entries with a status. **Decision**: annotate regardless; the visual result (dimmed + green) is fine and informative.
- **Performance**: `git status` per directory request is acceptable for typical repos. No caching in this plan. If profiling shows it's slow, add a per-root cache map invalidated by the fs watch.
- **No new tools, no new messages, no new API endpoints.** The data piggybacks on the existing `/api/fs` response.

**Further Considerations**

1. Should deleted files (which no longer exist on disk) appear in the tree? They won't — `listDir` reads the filesystem, and a deleted file has no directory entry. `git status` will show ` D` for it, but there's no file row to color. **No action needed.**
2. Should `fs_changed` (the fs watch) also trigger when git state changes without a filesystem change (e.g., `git add` doesn't modify the file)? **No** — `git add` doesn't change the file's mtime or directory listing, so the fs watch won't fire. The status will be stale until the next fs change or manual reload. **Acceptable** for this feature; a git-status watch is a follow-up.
3. The `git` binary must be on PATH. If it's missing, `spawnSync` will fail. **Handle gracefully**: if git fails (non-zero exit or spawn error), return without annotating (same as `annotateIgnored`'s error handling — it silently skips on error).
