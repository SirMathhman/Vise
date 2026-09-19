/**
 * The viewer's live edit_file diff-preview subsystem: the four functions
 * (`beginEditDiff`, `updateEditDiffNew`, `endEditDiff`, `cancelEditDiff`)
 * that let the LLM panel show an `edit_file` tool call as an inline unified
 * diff while its `content` argument is still streaming in. This is a pure
 * rendering concern over the viewer body — it fetches the file fresh, builds
 * the diff row DOM, and manages the live cursor — with no knowledge of the
 * tab system, the tree, or the LLM panel.
 *
 * It depends on `fileTree.ts` for `Viewer`/`ActiveDiff` (the shared viewer
 * state) and for `loadIntoViewer` (used by `endEditDiff`/`cancelEditDiff` to
 * reload the file from disk once the diff is dismissed). `loadIntoViewer`
 * is passed in as a callback to avoid a circular import.
 */

import { getFile } from "../api/client.js";
import { buildDiffRows, clampEditRange, type DiffRow } from "../diff.js";
import { appendHighlighted } from "../highlight.js";
import type { Viewer } from "./fileTree.js";

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
export async function beginEditDiff(
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
export function updateEditDiffNew(viewer: Viewer, text: string): void {
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
export function endEditDiff(viewer: Viewer, ok: boolean): void {
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
    void viewer.cb.loadIntoViewer(viewer, diff.rel);
  });
  viewer.actions.append(status, okBtn);
}

/** cancelEditDiff: see `FileViewerHandle`. */
export async function cancelEditDiff(viewer: Viewer): Promise<void> {
  const diff = viewer.activeDiff;
  if (!diff) return;
  await viewer.cb.loadIntoViewer(viewer, diff.rel);
}
