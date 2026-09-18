import { getFile, putFile, subscribeToChanges } from "../api/client.js";
import { appendHighlighted } from "../highlight.js";
import { makeContextMenu, showMenu } from "./contextMenu.js";
import { showCreateForm } from "./createDialog.js";
import {
  beginEditDiff,
  cancelEditDiff,
  endEditDiff,
  updateEditDiffNew,
} from "./editDiff.js";
import { createFileStateStore, type FileStateStore } from "./fileState.js";
import { createTabStore, type TabStore } from "./tabs.js";
import {
  activateTab,
  ensureBuffer,
  renderTabs,
  setTabSaveState,
  type TabCallbacks,
} from "./tabsView.js";
import { refreshDir, renderListing, scheduleLiveRefresh } from "./treePanel.js";

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
  const tabBar = root.querySelector<HTMLElement>("#tab-bar");

  // The open-file tab list and active tab id, restored from localStorage.
  const tabStore = createTabStore();
  // One buffer store per open tab (independent buffers — each tab autosaves
  // from its own text, so a background tab's 1s timer resolves from its own
  // buffer, not the shared textarea). The active tab's buffer is also
  // `viewer.store`; the others live only in this map.
  const tabBuffers = new Map<string, FileStateStore>();
  // Each open tab's live editor text, keyed by tab id — the canonical source
  // for that tab's buffer `reader` and for what its textarea shows.
  const tabText = new Map<string, string>();

  // The no-tab placeholder buffer: its `reader` reads `tabText.get("")` (always
  // undefined) and it is never marked dirty, so it behaves like an empty,
  // clean buffer. Assigned to `viewer.store` whenever no tab is active.
  // The placeholder is never dirty (its reader reads tabText.get(""), always
  // undefined), so its save-status callback is a no-op.
  const placeholderStore = createFileStateStore(
    (rel, value) => putFile(rel, value),
    () => {}
  );
  placeholderStore.setReader(() => tabText.get(""));

  const viewer: Viewer = {
    body: viewerBody,
    title: viewerTitle,
    actions: viewerActions,
    menu,
    list,
    lsPath,
    // Reassigned to the active tab's buffer whenever a tab is active (see
    // `activateTab`); the placeholder while no tab is active.
    store: placeholderStore,
    placeholderStore,
    tabBuffers,
    tabText,
    tabStore,
    expandedDirs: new Set<string>(),
    activeDiff: null,
    tabBar,
    cb: {
      viewFile: (rel, v) => viewFile(rel, v),
      renderEditor: (v) => renderEditor(v),
      setHint: (v, text, cls) => setHint(v.body, text, cls),
      loadIntoViewer: (v, rel) => loadIntoViewer(v, rel),
    },
  };
  window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    // Any open tab with unsaved edits blocks unload (the beforeunload source
    // of truth moved from a single store to "any tab dirty").
    if ([...tabBuffers.values()].some((s) => s.isDirty())) {
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
  // Render the tab bar from the restored open set (buffers not yet loaded, so
  // no dirty dots yet), then bring the active tab's file into the viewer.
  if (tabBar) renderTabs(viewer, viewer.cb);
  const activeTab = viewer.tabStore.getActive();
  if (activeTab) await viewFile(activeTab.rel, viewer);
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

export interface Viewer {
  body: HTMLPreElement;
  title: HTMLHeadingElement;
  actions: HTMLElement;
  menu: HTMLDivElement;
  list: HTMLUListElement;
  lsPath: HTMLElement;
  /**
   * The active tab's buffer store. The per-tab map below (`tabBuffers`) is
   * the real source of truth for each open tab's autosave lifecycle; `store`
   * is just a convenience reference to the active tab's entry, kept so the
   * many existing `viewer.store.*` call sites read unchanged. Reassigning
   * it on tab switch is what makes the active tab's textarea the live reader
   * for that tab's (background-safe) autosave timer.
   */
  store: FileStateStore;
  /** The no-tab placeholder buffer (assigned to `store` when no tab is active). */
  placeholderStore: FileStateStore;
  /** Every open tab's buffer store, keyed by tab id (the active tab's is also `store`). */
  tabBuffers: Map<string, FileStateStore>;
  /** Every open tab's last known editor text, keyed by tab id (backs each tab's buffer `reader`). */
  tabText: Map<string, string>;
  /** The open-file tab list and active tab id, persisted across reloads. */
  tabStore: TabStore;
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
  /** The tab bar element the tabs render into (absent if the shell lacks it). */
  tabBar: HTMLElement | null;
  /**
   * The tab callbacks (viewFile/renderEditor/setHint/loadIntoViewer) that
   * `tabsView.ts` needs but can't own without a circular import. Wired up in
   * `setupFileViewer` after the `viewer` object is constructed.
   */
  cb: TabCallbacks;
}

export interface ActiveDiff {
  rel: string;
  lines: string[];
  startLine: number;
  endLine: number;
  /** The container the added (green) rows are rendered into; rewritten on every `updateEditDiffNew`. */
  addedContainer: HTMLElement;
}

async function viewFile(rel: string, viewer: Viewer): Promise<void> {
  // Opening a file always lands on its tab: create one if absent, or activate
  // an existing one (e.g. the user re-clicks an already-open file). We must
  // flush the CURRENTLY active tab's buffer first — the shared textarea holds
  // that tab's content — before the switch reassigns `viewer.store`.
  const activeIdBefore = viewer.tabStore.activeId();
  if (activeIdBefore !== null) {
    const buffer = viewer.tabBuffers.get(activeIdBefore);
    const saved = buffer ? await buffer.flush() : true;
    if (!saved) return; // A pending save failed; abort so edits are not lost.
  }
  // Ensure a tab exists for this file and make it active.
  const tabId = viewer.tabStore.open(rel);
  viewer.tabStore.persist();
  const buffer = ensureBuffer(viewer, tabId);
  // Re-point `viewer.store` at this tab's buffer and re-render the tab bar.
  activateTab(viewer, tabId, viewer.cb);
  // If this tab's buffer already holds the file (a re-activation),
  // `activateTab` has already rendered it into the viewer — done.
  if (buffer.getRel() === rel && viewer.tabText.get(tabId) !== undefined) {
    return;
  }
  // New tab (or a restored tab whose buffer hasn't loaded yet): fetch the
  // file and seed its buffer.
  viewer.title.textContent = rel;
  viewer.actions.innerHTML = "";
  setHint(viewer.body, "Loading\u2026", "loading");
  try {
    const data = await getFile(rel);
    // Guard: if the user switched tabs during the fetch, don't clobber the
    // now-active tab's editor with this stale load.
    if (viewer.tabStore.activeId() !== tabId) return;
    // The heading shows the path relative to the workspace root, not the
    // absolute one: the absolute path wrapped the heading onto several
    // lines, and its root half is already displayed by the listing panel.
    // The full path stays reachable as the heading's tooltip.
    viewer.title.textContent = rel;
    viewer.title.title = data.path;
    buffer.beginLoad(rel, data.content);
    viewer.tabText.set(tabId, data.content);
    renderEditor(viewer);
    setTabSaveState(viewer, tabId, "saved");
  } catch (err) {
    if (viewer.tabStore.activeId() !== tabId) return;
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
  // Seed the editor from the active tab's buffer (the canonical source). Keep
  // `tabText` in sync with it so the active tab's background autosave timer
  // (which reads from `tabText`) sees the same text the textarea will show.
  const activeTabId = viewer.tabStore.activeId();
  const text = viewer.store.getContent() ?? "";
  if (activeTabId !== null) {
    viewer.tabText.set(activeTabId, text);
  }

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
  // The reader was already set at buffer creation to read this tab's stored
  // text (`tabText.get(tabId)`); that is the canonical, background-safe
  // source. We keep `tabText` in sync with the textarea on every input (see
  // the handler below) and on load (see the call site), so the reader always
  // sees the current content without any cross-tab coupling.
  ta.addEventListener("input", () => {
    paint();
    // Keep the active tab's stored text in sync with what the user is typing,
    // so its background autosave timer (which reads `tabText`) sees the new
    // content.
    const activeId = viewer.tabStore.activeId();
    if (activeId !== null) {
      viewer.tabText.set(activeId, ta.value);
    }
    viewer.store.markDirty();
    if (activeId !== null) {
      setTabSaveState(viewer, activeId, "unsaved");
    }
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
