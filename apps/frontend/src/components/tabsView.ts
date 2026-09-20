/**
 * The viewer's multi-tab subsystem: renders the tab bar (`#tab-bar`),
 * implements tab switching (`activateTab`), tab closing with the dirty
 * confirm (`closeTab`), background-tab reload, per-tab save-status spans,
 * and the get-or-create of per-tab buffer stores. It is the DOM controller
 * counterpart to `tabs.ts` (the DOM-free `TabStore`) and `fileState.ts`
 * (the DOM-free per-tab buffer): `tabs.ts` is testable in Node because it has
 * no DOM and no network; this module has the DOM (the tab bar and the
 * save-status span) and the network (`putFile`), so it lives here.
 *
 * It depends on `fileTree.ts` for three things it can't own without a
 * circular import: `viewFile` (the entry point that flushes the active tab,
 * opens/activates a tab, and fetches the file), `renderEditor` (which rebuilds
 * the editor's textarea from the active tab's buffer), and `setHint` (which
 * paints the no-tab hint into the viewer body). These are passed in as a
 * `TabCallbacks` object from `setupFileViewer`, mirroring the
 * dependency-injection shape `fileState.ts` uses to stay testable in Node.
 *
 * The per-tab buffer stores, per-tab text map, placeholder buffer, and the
 * `TabStore` all live on the `Viewer` struct (owned by `fileTree.ts`); this
 * module accesses them through the `viewer` parameter rather than keeping
 * its own copies, so there is a single source of truth.
 */

import { getFile, putFile } from "../api/client.js";
import { createFileStateStore, type FileStateStore } from "./fileState.js";
import type { Viewer } from "./fileTree.js";
import type { Tab } from "./tabs.js";

/**
 * The three `fileTree.ts` functions this module needs but can't own without a
 * circular import. Passed in from `setupFileViewer` at init time.
 */
export interface TabCallbacks {
  /** `fileTree.viewFile` — flush active tab, open/activate a tab, fetch the file. */
  viewFile(rel: string, viewer: Viewer): Promise<void>;
  /** `fileTree.renderEditor` — rebuild the editor textarea from the active tab's buffer. */
  renderEditor(viewer: Viewer): void;
  /** `fileTree.setHint` — paint a hint/error span into the viewer body. */
  setHint(viewer: Viewer, text: string, cls?: string): void;
  /** `fileTree.loadIntoViewer` — fetch a file and load it into the viewer (active tab). */
  loadIntoViewer(viewer: Viewer, rel: string): Promise<void>;
}

/**
 * Create a buffer store for a tab. The store's `reader` reads that tab's text
 * from `viewer.tabText`, so its autosave timer resolves from the tab's own
 * buffer, not the shared textarea.
 */
export function createBufferStoreForTab(
  viewer: Viewer,
  tabId: string
): FileStateStore {
  const s = createFileStateStore(
    (rel, value) => putFile(rel, value),
    (state, message) => setTabSaveState(viewer, tabId, state, message)
  );
  s.setReader(() => viewer.tabText.get(tabId));
  return s;
}

/**
 * Get-or-create the buffer store for a tab. Called when a tab first gets a
 * buffer (opening a file that isn't already open). The active tab's store is
 * also wired to `viewer.store` by the caller (`activateTab`).
 */
export function ensureBuffer(viewer: Viewer, tabId: string): FileStateStore {
  const existing = viewer.tabBuffers.get(tabId);
  if (existing) return existing;
  const store = createBufferStoreForTab(viewer, tabId);
  viewer.tabBuffers.set(tabId, store);
  return store;
}

/**
 * Bring the tab with this id to the front: point `viewer.store` at its buffer
 * (or the placeholder if it has none yet), and re-render the tab bar. The
 * caller is responsible for loading the file into the viewer (fetch +
 * `renderEditor`) when the buffer is empty; when the buffer already holds the
 * file (re-activating a tab), `renderEditor` re-renders from the stored text
 * without a fetch.
 */
export function activateTab(
  viewer: Viewer,
  tabId: string,
  cb: TabCallbacks
): void {
  viewer.tabStore.activate(tabId);
  const buffer = viewer.tabBuffers.get(tabId) ?? viewer.placeholderStore;
  viewer.store = buffer;
  if (viewer.tabBar) renderTabs(viewer, cb);
  // If the buffer already holds this tab's file (re-activating a tab),
  // re-render the editor from it without a fetch.
  const rel = buffer.getRel();
  if (
    rel !== undefined &&
    viewer.activeDiff === null &&
    viewer.tabText.get(tabId) !== undefined
  ) {
    viewer.title.textContent = rel;
    viewer.title.title = "";
    viewer.actions.innerHTML = "";
    cb.renderEditor(viewer);
    setTabSaveState(viewer, tabId, "saved");
  }
}

/**
 * Close the tab with this id: confirm if it has unsaved edits, drop its buffer
 * and text, and promote the next tab (or show the no-file hint when the last
 * tab is closed). Called from the tab bar's close button.
 */
export async function closeTab(
  viewer: Viewer,
  tabId: string,
  cb: TabCallbacks
): Promise<void> {
  const tab = viewer.tabStore.getTabs().find((t) => t.id === tabId);
  if (!tab) return;
  const buffer = viewer.tabBuffers.get(tabId);
  // A dirty tab: confirm before flushing, so a failed save keeps the tab open
  // (mirrors `viewFile`'s abort-on-failed-flush guard).
  if (buffer?.isDirty()) {
    const name = tab.rel.split("/").pop() ?? tab.rel;
    const ok = window.confirm(
      `Close "${name}" with unsaved edits? The edits will be saved first.`
    );
    if (!ok) return;
    const saved = await buffer.flush();
    if (!saved) return;
  }
  buffer?.clearTimer();
  viewer.tabBuffers.delete(tabId);
  viewer.tabText.delete(tabId);
  viewer.tabStore.close(tabId);
  viewer.tabStore.persist();
  const newActive = viewer.tabStore.getActive();
  if (newActive) {
    // The tab store promoted a new active tab; bring it into the viewer.
    await cb.viewFile(newActive.rel, viewer);
  } else {
    // No tabs left: show the no-file hint.
    viewer.store = viewer.placeholderStore;
    viewer.title.textContent = "File contents";
    viewer.title.title = "";
    viewer.actions.innerHTML = "";
    cb.setHint(viewer, "Select a file to view its contents.", "viewer-hint");
    if (viewer.tabBar) renderTabs(viewer, cb);
  }
}

/**
 * Render the tab bar from the store's open set. Each tab shows its file's base
 * name (the full rel path is the tooltip), a dirty dot when that tab's buffer
 * has unsaved edits, and a close (×) button. Clicking a tab activates it; the
 * close button closes it (with the dirty confirm above). Rebuilds the bar
 * wholesale on every call (the tab set is small, so a full rebuild is simpler
 * than diffing).
 */
/**
 * A URL tab's label: its host (`www.google.com`) rather than the full URL,
 * which would overflow the tab. Scheme-less or file: URLs have no host to
 * show, so fall back to the raw string.
 */
function hostnameOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return host !== "" ? host : url;
  } catch {
    return url;
  }
}

export function renderTabs(viewer: Viewer, cb: TabCallbacks): void {
  const bar = viewer.tabBar;
  if (!bar) return;
  bar.innerHTML = "";
  const tabs = viewer.tabStore.getTabs();
  const activeId = viewer.tabStore.activeId();
  for (const tab of tabs) {
    // Both web tab kinds (embedded iframe and the CDP browser surface) read
    // as web pages in the bar; only their rendering inside the viewer differs.
    const isUrl = tab.kind === "url" || tab.kind === "browser";
    const label = document.createElement("button");
    label.type = "button";
    label.className = `tab ${isUrl ? "tab-url" : ""} ${
      tab.id === activeId ? "tab-active" : ""
    }`;
    label.title = tab.rel;

    const name = document.createElement("span");
    name.className = "tab-name";
    // URL tabs show their host (e.g. `www.google.com`) rather than the full
    // URL, which would overflow the tab; the full URL stays the tooltip.
    name.textContent = isUrl
      ? hostnameOf(tab.rel)
      : (tab.rel.split("/").pop() ?? tab.rel);
    label.append(name);

    const buffer = viewer.tabBuffers.get(tab.id);
    if (buffer?.isDirty()) {
      const dot = document.createElement("span");
      dot.className = "tab-dirty";
      dot.textContent = "●";
      label.append(dot);
    }

    const close = document.createElement("button");
    close.type = "button";
    close.className = "tab-close";
    close.textContent = "×";
    close.setAttribute("aria-label", `Close ${tab.rel}`);
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      void closeTab(viewer, tab.id, cb);
    });
    label.append(close);

    label.addEventListener("click", () => {
      if (tab.id === activeId) return;
      void cb.viewFile(tab.rel, viewer);
    });
    bar.append(label);
  }
}

/**
 * Set the save-status span for a specific tab (identified by its tab id) in
 * the shared actions bar. Each tab has its own span (keyed by tab id), so
 * switching tabs shows that tab's own last save state rather than a shared,
 * clobbered one. The span is looked up by a `data-tab-id` attribute; if it
 * is missing (e.g. the actions bar was cleared for a loading hint or a diff
 * status) it is created fresh.
 */
export function setTabSaveState(
  viewer: Viewer,
  tabId: string,
  state: "unsaved" | "saving" | "saved" | "error",
  message?: string
): void {
  const actions = viewer.actions;
  let span = actions.querySelector<HTMLElement>(`[data-tab-id="${tabId}"]`);
  if (!span) {
    span = document.createElement("span");
    span.className = "save-status";
    span.dataset.tabId = tabId;
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

/**
 * Reload a background (non-active) tab's file from disk into its buffer and
 * its stored text, without disturbing the active tab's editor. Only called
 * when the buffer is clean (the caller guards on `isDirty()`).
 */
export async function reloadBackgroundTab(
  viewer: Viewer,
  tab: Tab
): Promise<void> {
  const buffer = viewer.tabBuffers.get(tab.id);
  if (!buffer) return;
  try {
    const data = await getFile(tab.rel);
    buffer.beginLoad(tab.rel, data.content);
    viewer.tabText.set(tab.id, data.content);
  } catch {
    // If the file vanished between the event and the read, leave the buffer as
    // is; the next successful refresh will settle it.
  }
}

/**
 * Reload every open tab whose file changed on disk, in tab order. For each
 * tab we consult ITS buffer (not the active one), so an in-progress edit in
 * one tab is never clobbered while another tab's file changed. The active
 * tab's title is updated in place (it's the one the user sees); background
 * tabs' buffers are refreshed but their titles aren't re-rendered (the tab
 * bar only re-renders on tab changes, not file reloads).
 */
export async function reloadOpenTabs(
  viewer: Viewer,
  rel: string,
  cb: TabCallbacks
): Promise<void> {
  for (const tab of viewer.tabStore.getTabs()) {
    const buffer = viewer.tabBuffers.get(tab.id);
    // URL tabs own no buffer (they render an iframe, not an editor); they
    // are never affected by file watch events.
    if (!buffer) continue;
    const openRel = buffer.getRel();
    if (openRel !== rel) continue;
    if (
      viewer.activeDiff?.rel === rel &&
      viewer.tabStore.activeId() === tab.id
    ) {
      // The active tab is showing a live edit_file diff preview for this very
      // file — almost always the preview's own write, landing ~100-200ms
      // after the tool call resolves, well before a human reacts.
      // `beginEditDiff` never touches `buffer` (there is no plain-editor
      // buffer while a diff is up), so a naive reload would clobber the
      // preview and defeat endEditDiff's "wait for the user's own OK click"
      // behavior. Leave it exactly as endEditDiff left it.
      continue;
    }
    if (!buffer.isDirty()) {
      // Changed on disk and clean: reload. For the active tab this re-renders
      // the editor; for a background tab it updates the buffer and the text
      // shown when the tab is next activated (tabText), without disturbing
      // the active tab's editor.
      if (viewer.tabStore.activeId() === tab.id) {
        await cb.loadIntoViewer(viewer, rel);
      } else {
        await reloadBackgroundTab(viewer, tab);
      }
    } else if (viewer.tabStore.activeId() === tab.id) {
      // Active tab, changed on disk but dirty: keep the edits, just tell the
      // user the file is out of date so they can decide to reload.
      viewer.title.textContent = `${rel} (out of date)`;
    }
  }
}

/**
 * Mark the buffer of whichever tab had the deleted file loaded clean, so the
 * delete's own watch event doesn't flag it out-of-date.
 */
export function resetDeletedTabBuffers(viewer: Viewer, rel: string): void {
  for (const tab of viewer.tabStore.getTabs()) {
    const buffer = viewer.tabBuffers.get(tab.id);
    if (buffer?.getRel() === rel) buffer.resetDirty();
  }
}
