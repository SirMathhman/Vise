import {
  deleteFile as apiDelete,
  type DirEntry,
  getFile,
  listDir,
  putFile,
  subscribeToChanges,
} from "../api/client.js";
import { buildDiffRows, clampEditRange, type DiffRow } from "../diff.js";
import { appendHighlighted } from "../highlight.js";
import { makeContextMenu, showMenu } from "./contextMenu.js";
import { showCreateForm } from "./createDialog.js";
import { createFileStateStore, type FileStateStore } from "./fileState.js";

/**
 * Lets another panel (the LLM chat) drive the file viewer to preview an
 * edit_file tool call live, as an inline diff — the same shape most editors
 * show a git diff in (dual gutters, red removed / green added rows) — before
 * the call actually executes on the backend. `setupFileViewer` returns this
 * so `render.ts` can hand it to `setupLlm`; the two panels are otherwise
 * fully decoupled (the viewer knows nothing about conversations or tools).
 */
export interface FileViewerHandle {
  /**
   * Try to open `rel` and show it as a live diff over `[startLine, endLine)`
   * (1-based, exclusive end, matching edit_file's own semantics — see
   * `diff.ts`). Flushes any pending edit first, exactly like clicking a file
   * in the tree, so an in-progress manual edit is never silently discarded;
   * returns `false` (and touches nothing) if that flush fails or the file
   * can't be read, so the caller can skip the live preview for this call
   * without blocking the model's actual edit.
   */
  beginEditDiff(
    rel: string,
    startLine: number,
    endLine: number
  ): Promise<boolean>;
  /**
   * Update the added (green) rows from the call's `content` argument so far,
   * split on newlines. A no-op if a later `beginEditDiff`/normal navigation
   * has since taken over the viewer.
   */
  updateEditDiffNew(text: string): void;
  /**
   * Settle the diff once the call has actually executed on the backend (or
   * failed — the chat transcript reports that separately): stop the live
   * cursor, show the outcome, and leave the diff up — red/green and all —
   * until the user dismisses it with the OK button that appears alongside
   * the outcome. Only then does the viewer reload the file from disk and
   * drop back to the plain (non-diff) editable view, which still shows the
   * edit's real result — the color goes away, not the content. A no-op
   * under the same supersede condition as `updateEditDiffNew`.
   */
  endEditDiff(ok: boolean): void;
  /**
   * Abandon an in-progress preview immediately, with no dismiss step — for
   * when the call never actually ran (the user clicked Stop, or the turn
   * was rolled back), so there is no real outcome to show or wait on.
   * Reloads the file from disk right away. A no-op under the same supersede
   * condition as `updateEditDiffNew`.
   */
  cancelEditDiff(): Promise<void>;
}

/**
 * Wire up the file tree/listing and the editor/viewer panels. This is the
 * thin DOM controller for the left (tree) and center (viewer) panels: it
 * queries the elements, builds the shared `Viewer` state, wires the context
 * menu and `beforeunload` guard, renders the initial listing, and owns the
 * tree expand/refresh and the editor's auto-save lifecycle. Returns a
 * `FileViewerHandle` so the LLM panel can preview an edit_file call live.
 */
export async function setupFileViewer(
  root: HTMLElement
): Promise<FileViewerHandle | undefined> {
  const lsPath = root.querySelector<HTMLElement>("#ls-path");
  const list = root.querySelector<HTMLUListElement>("#ls-items");
  const viewerBody = root.querySelector<HTMLPreElement>("#viewer-body");
  const viewerTitle = root.querySelector<HTMLHeadingElement>("#viewer-title");
  const viewerActions = root.querySelector<HTMLElement>("#viewer-actions");
  if (!lsPath || !list || !viewerBody || !viewerTitle || !viewerActions) {
    return undefined;
  }

  const menu = makeContextMenu();
  const store = createFileStateStore(
    (rel, value) => putFile(rel, value),
    (state, message) => setSaveState(viewerActions, state, message)
  );
  const viewer: Viewer = {
    body: viewerBody,
    title: viewerTitle,
    actions: viewerActions,
    menu,
    list,
    lsPath,
    store,
    expandedDirs: new Set<string>(),
    activeDiff: null,
  };
  window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    if (store.isDirty()) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  list.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(viewer.menu, e.clientX, e.clientY, [
      {
        label: "New File",
        onClick: () =>
          showCreateForm("file", "", (name) => {
            void refreshDir(viewer, "", null);
            void viewFile(name, viewer);
          }),
      },
      {
        label: "New Directory",
        onClick: () =>
          showCreateForm("directory", "", () => {
            void refreshDir(viewer, "", null);
          }),
      },
    ]);
  });
  await renderListing(list, lsPath, "", viewer);
  subscribeToChanges((e) => scheduleLiveRefresh(viewer, e));

  return {
    beginEditDiff: (rel, startLine, endLine) =>
      beginEditDiff(viewer, rel, startLine, endLine),
    updateEditDiffNew: (text) => updateEditDiffNew(viewer, text),
    endEditDiff: (ok) => endEditDiff(viewer, ok),
    cancelEditDiff: () => cancelEditDiff(viewer),
  };
}

/**
 * Debounced live-refresh: on a filesystem change, refresh the root plus every
 * expanded directory, and reload the open file in the viewer (only when its
 * buffer is clean, so a user mid-edit is never clobbered). A short timer
 * collapses the burst of events a single edit typically produces.
 */
let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleLiveRefresh(viewer: Viewer, e: { path: string }): void {
  if (liveRefreshTimer !== undefined) clearTimeout(liveRefreshTimer);
  liveRefreshTimer = setTimeout(() => {
    liveRefreshTimer = undefined;
    void liveRefresh(viewer, e.path);
  }, 80);
}

async function liveRefresh(viewer: Viewer, rel: string): Promise<void> {
  await refreshDir(viewer, "", null);
  // Re-locate expanded dirs: their `li` nodes may have been recreated by the
  // refresh above, so look them up fresh in the current DOM. Refresh ancestors
  // first (shortest rel first) so a nested dir is re-located on the node its
  // parent's re-render just created.
  const dirs = [...viewer.expandedDirs].sort(
    (a, b) => a.split("/").length - b.split("/").length
  );
  for (const dirRel of dirs) {
    const li = findDirLi(viewer.list, dirRel);
    if (li) await refreshDir(viewer, dirRel, li);
  }

  if (viewer.activeDiff?.rel === rel) {
    // A live edit_file diff preview is showing for the very file that just
    // changed on disk — almost always the preview's own write, landing
    // ~100-200ms after the tool call resolves, well before a human reacts.
    // `beginEditDiff` never touches `viewer.store` (there is no plain-editor
    // buffer while a diff is up), so the checks below have no idea a diff is
    // showing and would otherwise reload right over it via the same
    // `openRel` match a manually-open file gets — silently defeating
    // endEditDiff's "wait for the user's own OK click" behavior in the most
    // common case (the file being edited is usually the one already open).
    // Leave it exactly as endEditDiff left it.
    return;
  }
  const openRel = viewer.store.getRel();
  if (!openRel) return;
  if (rel === openRel && !viewer.store.isDirty()) {
    // The open file changed on disk and we have no unsaved edits: reload it.
    await loadIntoViewer(viewer, openRel);
  } else if (rel === openRel) {
    // Changed on disk but the buffer has unsaved edits: keep them, just tell
    // the user the file is out of date so they can decide to reload.
    viewer.title.textContent = `${openRel} (out of date)`;
  }
}

/** Locate the `<li>` for a directory (by rel) in the current tree DOM. */
function findDirLi(list: HTMLUListElement, rel: string): HTMLLIElement | null {
  const parts = rel.split("/");
  let current: HTMLUListElement | null = list;
  let found: HTMLLIElement | null = null;
  for (const part of parts) {
    if (!current) return null;
    found =
      (Array.from(current.children).find(
        (el) =>
          el instanceof HTMLLIElement &&
          el.classList.contains("directory") &&
          el.querySelector(".name")?.textContent === part
      ) as HTMLLIElement | undefined) ?? null;
    if (!found) return null;
    current = found.querySelector(":scope > ul");
  }
  return found;
}

/**
 * Load a file straight into the viewer without a navigation flush — used by the
 * live-refresh path, where the buffer is known clean and there is no pending
 * save to preserve.
 */
async function loadIntoViewer(viewer: Viewer, rel: string): Promise<void> {
  viewer.title.textContent = rel;
  try {
    const data = await getFile(rel);
    // The heading shows the path relative to the workspace root, not the
    // absolute one: the absolute path wrapped the heading onto several
    // lines, and its root half is already displayed by the listing panel.
    // The full path stays reachable as the heading's tooltip.
    viewer.title.textContent = rel;
    viewer.title.title = data.path;
    viewer.store.beginLoad(rel, data.content);
    renderEditor(viewer);
  } catch {
    // If the file vanished between the event and the read, leave the viewer as
    // is; the next successful refresh will settle it.
  }
}

interface Viewer {
  body: HTMLPreElement;
  title: HTMLHeadingElement;
  actions: HTMLElement;
  menu: HTMLDivElement;
  list: HTMLUListElement;
  lsPath: HTMLElement;
  store: FileStateStore;
  /** Rel paths of directories currently expanded in the tree. */
  expandedDirs: Set<string>;
  /**
   * The live edit_file diff currently shown, if any. Its identity (not just
   * its fields) is the guard: `updateEditDiffNew`/`endEditDiff` only act
   * when the `ActiveDiff` object they were handed is still this one, so a
   * superseded preview (the user navigated away, or a second edit_file call
   * took over the viewer) silently stops updating instead of fighting
   * whatever replaced it.
   */
  activeDiff: ActiveDiff | null;
}

/** The live state of one in-progress edit_file diff preview. */
interface ActiveDiff {
  rel: string;
  lines: string[];
  startLine: number;
  endLine: number;
  /** The container the added (green) rows are rendered into; rewritten on every `updateEditDiffNew`. */
  addedContainer: HTMLElement;
}

async function renderListing(
  list: HTMLUListElement,
  lsPath: HTMLElement,
  rel: string,
  viewer: Viewer
): Promise<void> {
  try {
    const data = await listDir(rel);
    if (rel === "") lsPath.textContent = data.path;
    list.innerHTML = "";
    for (const item of data.items) {
      list.append(renderEntry(item, rel, viewer));
    }
  } catch (err) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "error";
    li.textContent = `Failed to load: ${(err as Error).message}`;
    list.append(li);
  }
}

function renderEntry(
  item: DirEntry,
  parentRel: string,
  viewer: Viewer
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = item.kind;
  const row = document.createElement("div");
  row.className = "row";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.kind === "directory" ? "dir" : "file";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.name;

  const childRel = parentRel ? `${parentRel}/${item.name}` : item.name;

  if (item.kind === "directory") {
    const toggle = document.createElement("button");
    toggle.className = "toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▸";
    toggle.addEventListener(
      "click",
      () => void expandDir(toggle, li, childRel, viewer)
    );
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(viewer.menu, e.clientX, e.clientY, [
        {
          label: "New File",
          onClick: () =>
            showCreateForm("file", childRel, (name) => {
              void refreshDir(viewer, childRel, li);
              void viewFile(childRel ? `${childRel}/${name}` : name, viewer);
            }),
        },
        {
          label: "New Directory",
          onClick: () =>
            showCreateForm("directory", childRel, () => {
              void refreshDir(viewer, childRel, li);
            }),
        },
      ]);
    });
    row.append(toggle, badge, name);
  } else {
    row.classList.add("clickable");
    row.addEventListener("click", () => void viewFile(childRel, viewer));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(viewer.menu, e.clientX, e.clientY, [
        {
          label: "Delete",
          onClick: () => void deleteFile(childRel, parentRel, li, viewer),
        },
      ]);
    });
    row.append(badge, name);
  }

  li.append(row);
  return li;
}

async function deleteFile(
  rel: string,
  parentRel: string,
  li: HTMLLIElement,
  viewer: Viewer
): Promise<void> {
  const name = rel.split("/").pop() ?? rel;
  const ok = window.confirm(`Delete "${name}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await apiDelete(rel);
    if (parentRel === "") {
      await renderListing(viewer.list, viewer.lsPath, "", viewer);
    } else {
      const parentLi = li.parentElement?.parentElement;
      if (parentLi instanceof HTMLLIElement) {
        await refreshDir(viewer, parentRel, parentLi);
      }
    }
    viewer.store.resetDirty();
    setHint(viewer.body, `Deleted "${name}".`, "viewer-hint");
  } catch (err) {
    setHint(
      viewer.body,
      `Delete failed: ${(err as Error).message}`,
      "viewer-error"
    );
  }
}

function setHint(
  body: HTMLPreElement,
  text: string,
  cls = "viewer-hint"
): void {
  body.innerHTML = "";
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  body.append(span);
}

async function viewFile(rel: string, viewer: Viewer): Promise<void> {
  const saved = await viewer.store.flush();
  if (!saved) {
    // The pending save failed; abort so edits are not lost.
    return;
  }
  viewer.title.textContent = rel;
  viewer.actions.innerHTML = "";
  setHint(viewer.body, "Loading\u2026", "loading");
  try {
    const data = await getFile(rel);
    // The heading shows the path relative to the workspace root, not the
    // absolute one: the absolute path wrapped the heading onto several
    // lines, and its root half is already displayed by the listing panel.
    // The full path stays reachable as the heading's tooltip.
    viewer.title.textContent = rel;
    viewer.title.title = data.path;
    viewer.store.beginLoad(rel, data.content);
    renderEditor(viewer);
  } catch (err) {
    setHint(
      viewer.body,
      `Failed to load: ${(err as Error).message}`,
      "viewer-error"
    );
  }
}

function renderEditor(viewer: Viewer): void {
  // Normal navigation supersedes any live edit_file preview.
  viewer.activeDiff = null;
  viewer.store.clearTimer();
  viewer.actions.innerHTML = "";
  const text = viewer.store.getContent() ?? "";

  // A transparent-text textarea sits on top of a live-highlighted backdrop.
  // Both share identical font metrics (inherited from .editor-scroll) and
  // no wrapping, so the colored text lines up exactly with the edited text.
  const scroller = document.createElement("div");
  scroller.className = "editor-scroll";
  const grid = document.createElement("div");
  grid.className = "editor-grid";
  const gutter = document.createElement("div");
  gutter.className = "editor-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const code = document.createElement("div");
  code.className = "editor-code";
  const backdrop = document.createElement("pre");
  backdrop.className = "editor-backdrop";
  const ta = document.createElement("textarea");
  ta.className = "editor-input";
  ta.spellcheck = false;
  ta.setAttribute("aria-label", "file contents");

  const paint = (): void => {
    const lines = ta.value.split(/\r?\n/);
    const gut = document.createDocumentFragment();
    const back = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const no = document.createElement("span");
      no.className = "line-no";
      no.textContent = String(i + 1);
      gut.append(no);
      const line = document.createElement("div");
      line.className = "line";
      const lineText = document.createElement("span");
      lineText.className = "line-text";
      appendHighlighted(lineText, lines[i]);
      line.append(lineText);
      back.append(line);
    }
    gutter.textContent = "";
    gutter.append(gut);
    backdrop.textContent = "";
    backdrop.append(back);
  };

  ta.value = text;
  paint();
  viewer.store.setReader(() => ta.value);
  ta.addEventListener("input", () => {
    paint();
    viewer.store.markDirty();
    setSaveState(viewer.actions, "unsaved");
    viewer.store.scheduleSave();
  });

  code.append(backdrop, ta);
  grid.append(gutter, code);
  scroller.append(grid);
  // .editor-scroll is the sole scroller in edit mode; suppress the
  // #viewer-body scroll so only one scrollbar shows.
  viewer.body.style.overflow = "hidden";
  // Drop the read-only rendering first: the editor is absolutely
  // positioned over #viewer-body, so anything left behind shows through
  // as a second, misaligned copy of the text.
  viewer.body.innerHTML = "";
  viewer.body.append(scroller);
  ta.focus();
}

/** Build one diff row's DOM: old/new gutter numbers, a marker, then the (syntax-highlighted) text. */
function renderDiffRow(row: DiffRow): HTMLElement {
  const el = document.createElement("div");
  el.className =
    row.marker === "-"
      ? "diff-row diff-row-removed"
      : row.marker === "+"
        ? "diff-row diff-row-added"
        : "diff-row";

  const oldNo = document.createElement("span");
  oldNo.className = "diff-old-no";
  oldNo.textContent = row.oldNum === null ? "" : String(row.oldNum);

  const newNo = document.createElement("span");
  newNo.className = "diff-new-no";
  newNo.textContent = row.newNum === null ? "" : String(row.newNum);

  const marker = document.createElement("span");
  marker.className = "diff-marker";
  marker.textContent = row.marker;

  const text = document.createElement("span");
  text.className = "diff-text";
  appendHighlighted(text, row.text);

  el.append(oldNo, newNo, marker, text);
  return el;
}

/**
 * beginEditDiff: see `FileViewerHandle`. Flushes any pending edit first
 * (same guard `viewFile` uses), then fetches the file fresh and mounts the
 * static skeleton (context before/after + the removed rows) with an empty
 * added section, ready for `updateEditDiffNew` to fill in as content streams.
 */
async function beginEditDiff(
  viewer: Viewer,
  rel: string,
  startLine: number,
  endLine: number
): Promise<boolean> {
  const saved = await viewer.store.flush();
  if (!saved) return false;
  let content: string;
  try {
    const data = await getFile(rel);
    content = data.content;
  } catch {
    return false;
  }

  viewer.store.clearTimer();
  viewer.title.textContent = rel;
  viewer.actions.innerHTML = "";
  const lines = content.split(/\r?\n/);
  const { start, end } = clampEditRange(startLine, endLine, lines.length);

  const scroller = document.createElement("div");
  scroller.className = "diff-scroll";
  scroller.append(...buildDiffRows(lines, start, end, []).map(renderDiffRow));
  // The added rows live in their own container so updateEditDiffNew can
  // rewrite just that slice without rebuilding the (static) rest each chunk.
  // It's inserted once, right where the removed rows end, by re-deriving the
  // row list with a single placeholder and swapping that node for the
  // container — simplest way to reserve the right spot without hand-tracking
  // DOM indices.
  const placeholderIndex = end - start; // number of context-before + removed rows
  const addedContainer = document.createElement("div");
  addedContainer.className = "diff-added-container";
  const beforeAddedChildren = [...scroller.children];
  const anchor = beforeAddedChildren[placeholderIndex] ?? null;
  scroller.insertBefore(addedContainer, anchor);

  viewer.body.style.overflow = "hidden";
  viewer.body.innerHTML = "";
  viewer.body.append(scroller);
  viewer.activeDiff = {
    rel,
    lines,
    startLine: start,
    endLine: end,
    addedContainer,
  };
  // A cursor immediately, even before any content has streamed in, so the
  // diff doesn't sit looking finished while the model is still generating.
  const cursor = document.createElement("span");
  cursor.className = "diff-cursor";
  addedContainer.append(cursor);
  addedContainer.scrollIntoView({ block: "center" });
  return true;
}

/** updateEditDiffNew: see `FileViewerHandle`. */
function updateEditDiffNew(viewer: Viewer, text: string): void {
  const diff = viewer.activeDiff;
  if (!diff) return;
  const newLines = text === "" ? [] : text.split(/\r?\n/);
  diff.addedContainer.innerHTML = "";
  const rows = buildDiffRows(diff.lines, diff.startLine, diff.endLine, newLines)
    .filter((r) => r.marker === "+")
    .map(renderDiffRow);
  diff.addedContainer.append(...rows);
  const cursor = document.createElement("span");
  cursor.className = "diff-cursor";
  const lastText = rows.at(-1)?.querySelector(".diff-text");
  (lastText ?? diff.addedContainer).append(cursor);
}

/** endEditDiff: see `FileViewerHandle`. */
function endEditDiff(viewer: Viewer, ok: boolean): void {
  const diff = viewer.activeDiff;
  if (!diff) return;
  diff.addedContainer.querySelector(".diff-cursor")?.remove();

  viewer.actions.innerHTML = "";
  const status = document.createElement("span");
  status.className = `diff-status ${ok ? "diff-status-ok" : "diff-status-error"}`;
  status.textContent = ok ? "Edited" : "Edit failed";
  const okBtn = document.createElement("button");
  okBtn.type = "button";
  okBtn.className = "btn";
  okBtn.textContent = "OK";
  // Dismiss: drop the diff and its colors, keeping the edit's real result —
  // loadIntoViewer re-fetches from disk, which already has whatever the
  // call actually did (or didn't, on failure) applied.
  okBtn.addEventListener("click", () => {
    void loadIntoViewer(viewer, diff.rel);
  });
  viewer.actions.append(status, okBtn);
}

/** cancelEditDiff: see `FileViewerHandle`. */
async function cancelEditDiff(viewer: Viewer): Promise<void> {
  const diff = viewer.activeDiff;
  if (!diff) return;
  await loadIntoViewer(viewer, diff.rel);
}

function setSaveState(
  actions: HTMLElement,
  state: "unsaved" | "saving" | "saved" | "error",
  message?: string
): void {
  let span = actions.querySelector<HTMLElement>(".save-status");
  if (!span) {
    span = document.createElement("span");
    span.className = "save-status";
    actions.append(span);
  }
  span.className = `save-status save-status-${state}`;
  span.textContent =
    state === "unsaved"
      ? "\u25CF unsaved"
      : state === "saving"
        ? "saving\u2026"
        : state === "saved"
          ? "saved"
          : `save failed${message ? `: ${message}` : ""}`;
}

async function expandDir(
  toggle: HTMLButtonElement,
  li: HTMLLIElement,
  rel: string,
  viewer: Viewer
): Promise<void> {
  const expanded = toggle.getAttribute("aria-expanded") === "true";
  if (expanded) {
    toggle.textContent = "▸";
    toggle.setAttribute("aria-expanded", "false");
    viewer.expandedDirs.delete(rel);
    const existing = li.querySelector(":scope > ul");
    if (existing) existing.remove();
    return;
  }

  toggle.textContent = "▾";
  toggle.setAttribute("aria-expanded", "true");
  viewer.expandedDirs.add(rel);
  const existing = li.querySelector(":scope > ul");
  if (existing) {
    existing.remove();
    return;
  }

  const childList = document.createElement("ul");
  childList.className = "children";
  childList.setAttribute("aria-label", `${rel} contents`);
  li.append(childList);
  await renderListing(childList, li, rel, viewer);
}

async function refreshDir(
  viewer: Viewer,
  rel: string,
  targetLi: HTMLLIElement | null
): Promise<void> {
  if (!targetLi) {
    await renderListing(viewer.list, viewer.lsPath, "", viewer);
    return;
  }
  viewer.expandedDirs.add(rel);
  const toggle = targetLi.querySelector<HTMLButtonElement>(".toggle");
  if (toggle) {
    toggle.textContent = "▾";
    toggle.setAttribute("aria-expanded", "true");
  }
  let childList = targetLi.querySelector<HTMLUListElement>(":scope > ul");
  if (!childList) {
    childList = document.createElement("ul");
    childList.className = "children";
    childList.setAttribute("aria-label", `${rel} contents`);
    targetLi.append(childList);
  }
  await renderListing(childList, targetLi, rel, viewer);
}
