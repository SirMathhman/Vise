## Plan: Right-Click Context Menu for New File / New Directory

Add "New File" and "New Directory" items to the right-click context menu in the web file explorer. Right-clicking on a directory row or in the empty space of the tree (at root or inside any directory) prompts for a name and creates the entry via a new server endpoint.

**Steps**

### Phase 1 — Prompt dialog (frontend, standalone)

1. Create `web/src/feedback/prompt.ts` — a `promptAction(title: string, placeholder?: string): Promise<string | null>` function modeled directly on `confirmAction` in `web/src/feedback/confirm.ts`. It creates a `<dialog>` element appended to `document.body`, contains a heading, a `<input type="text">`, and Cancel/OK buttons. Returns the entered string on OK, `null` on Cancel/Escape. Focus the input (select all). Reuse the `confirm-dialog` CSS class from `web/styles/feedback.css` (or add minimal styles if needed). No existing prompt dialog exists in the codebase — this is the first.

**Verification for Phase 1:** call `promptAction("Test")` from the browser console; type a value and press OK — the promise resolves with the string. Press Cancel — it resolves with `null`. Press Escape — same.

### Phase 2 — Server: create endpoint

2. Add `createPath(root: string, rel: string, isDir: boolean): string` to `src/web/api/files.ts`. Follows the pattern of `deletePath` in the same file: resolve the relative path against the root, validate it (reject `..` segments, reject empty/whitespace names, reject names containing `/`), then either `mkdir` (for a directory) or create an empty file (for a file). Return an error string (not a throw) on failure (already exists, invalid name, etc.). _No dependencies._

3. Add the route `POST /api/create?path=<rel>&dir=<0|1>` to `src/web/http.ts`, following the existing `POST /api/delete` pattern. Call `createPath` and return the result as JSON (`{ ok: true }` or `{ error: "..." }`). _Depends on 2._

**Verification for Phase 2:** with the server running, `curl -X POST 'http://localhost:3000/api/create?path=test.txt&dir=0'` creates an empty file `test.txt` in the root. `curl -X POST 'http://localhost:3000/api/create?path=testdir&dir=1'` creates a directory. A duplicate returns an error. A path with `..` is rejected.

### Phase 3 — Frontend: wire up the context menu

4. In `web/src/workspace/explorer.ts`, add a `newEntry(parentPath: string, isDir: boolean): Promise<void>` helper. It calls `promptAction(isDir ? "New Directory" : "New File")`; if the result is a non-empty string, builds the full relative path (`parentPath === "" ? name : parentPath + "/" + name`), POSTs to `/api/create`, calls `reload()` on success, and shows a `toast()` on error.

5. **Directory-row context menu:** Modify `makeEntryOps` (line 448) to accept an optional `isDir: boolean` flag (or split into two: `makeFileOps` and `makeDirOps`). When `isDir` is true, prepend `{ label: "New File", run: () => void newEntry(path, false) }` and `{ label: "New Directory", run: () => void newEntry(path, true) }` to the `showMenu` items array. The `path` here is the directory's own path (the parent in which to create). Update the call sites where `dirRow` and `fileRow` receive their `onContext` handler to pass the correct flag. _Depends on 4._

6. **Root-level / empty-space context menu:** Add a `contextmenu` event listener on `#files-list` (the root `<ul>`). In the handler, check `if ((e.target as HTMLElement).closest(".fs-row"))` — if it's a row, the row's own handler already fired (and called `preventDefault()`), so return early. Otherwise, `e.preventDefault()` and `showMenu(e.clientX, e.clientY, [New File, New Directory])` calling `newEntry("", isDir)` (empty parent = root). _Depends on 4._

**Verification for Phase 3 (manual):**

- Right-click on a directory row → context menu shows "New File", "New Directory", "Copy relative path", "Copy absolute path", "Delete…". Pick "New File" → prompt appears → type name → OK → file appears in tree after reload.
- Right-click on a file row → context menu shows only the existing items (no "New File"/"New Directory").
- Right-click in the empty space below all entries at the root → "New File" / "New Directory" → creates at root.
- Right-click in the empty space inside an expanded directory's children (below the last child, on the `<ul>` background) → creates inside that directory. (This works because the `<ul class="fs-children">` is inside the `<li>` and the event target is not a `.fs-row`, but we need the handler to determine the correct parent path. See note below.)
- Create a file that already exists → error toast.
- Press Cancel or Escape in the prompt → nothing created.

**Note on step 6 (empty space inside a directory):** The empty space inside a directory is the `<ul class="fs-children">` element or the `<li>` wrapper. The `#files-list` listener will catch it, but we need to determine the parent directory. Solution: in the handler, walk up from `e.target` to find the nearest ancestor `<li>` whose inner `<div class="fs-row fs-dir">` exists, and read its `data-path`. If found, use that path as the parent. If not found (true root-level empty space), use `""`. This is a small helper: `parentDirOf(target: HTMLElement): string | null`.

### Phase 4 — CSS (minimal)

7. If the prompt dialog needs styles beyond what `confirm-dialog` already provides (e.g., the `<input>` inside the dialog), add a few rules to the appropriate CSS file in `web/styles/`. The input should be full-width, padded, and use the `.field` class or equivalent token-based styling. _Depends on 1._

**Verification for Phase 4:** The prompt dialog is visually consistent with the confirm dialog — same font, padding, button style, input field uses the shared `.field` class.

**Relevant files**

- `web/src/feedback/prompt.ts` — **new file**: `promptAction()` modeled on `confirmAction` in `confirm.ts`
- `web/src/feedback/confirm.ts` — reference pattern for dialog structure, `<dialog>` lifecycle, promise resolution
- `web/src/workspace/explorer.ts` — `makeEntryOps` (line 448), `dirRow` (line 315, `onContext` param), `fileRow` (line 291), `reload()` (line 130), `api()` helper (line 477)
- `web/src/workspace/tab-menu.ts` — `showMenu(x, y, items)` and `MenuItem` interface `{ label, disabled?, danger?, run() }`
- `src/web/api/files.ts` — add `createPath()` alongside existing `deletePath()`
- `src/web/http.ts` — add `POST /api/create` route alongside existing `POST /api/delete`
- `web/src/feedback/toast.ts` — `toast()` for error notifications
- `web/styles/` — prompt dialog CSS (input field styling)
- `web/index.html` — `#files-list` element (line ~195) — the target for the root-level `contextmenu` listener

**Decisions**

- **Prompt dialog over inline input:** the user chose a prompt dialog (modal) for entering the name, not inline editing in the tree.
- **Context-aware parent:** right-clicking on a directory row creates inside that directory; right-clicking in empty space at the root creates at the root; right-clicking in the empty space inside a directory's children creates inside that directory (determined by walking up to the nearest `<li>` with a `fs-dir` row).
- **Directory rows get the new items, file rows do not:** "New File" and "New Directory" make sense only on directories (you create _inside_ a directory). File rows keep their existing menu unchanged.
- **Creation is atomic and simple:** the server creates an empty file or an empty directory. No content is written. No recursive mkdir. If the entry already exists, return an error.
- **No keyboard shortcut:** right-click is the trigger; no additional shortcut is added in this plan.
- **`fs_changed` watcher will pick up the new entry** automatically and reload the tree — no explicit `fs_changed` message is needed from the server, but we call `reload()` in the frontend for immediate feedback.

**Scope boundaries**

- **Included:** right-click context menu on directory rows and empty space; "New File" and "New Directory" items; prompt dialog for name entry; server endpoint for creation.
- **Excluded:** renaming, moving, creating files with initial content, drag-and-drop, keyboard shortcuts, creating multiple entries at once, creating in the viewer pane (only the tree).
