/**
 * The file tree/listing subsystem: renders the directory listing, handles
 * file/directory expand/collapse, file deletion, the context menu, and the
 * debounced live-refresh that re-renders expanded directories and reloads
 * open tabs when the filesystem changes. It is the DOM controller for the
 * left panel (the tree) — the counterpart to `tabsView.ts` (the tab bar) and
 * `editDiff.ts` (the diff preview).
 *
 * It depends on `fileTree.ts` for the `Viewer` type (type-only import, erased
 * at runtime — no circular runtime dependency) and accesses `viewFile` and
 * `setHint` through `viewer.cb` (the same callback-injection pattern
 * `tabsView.ts` uses) to avoid a circular runtime import.
 */

import {
  deleteFile as apiDelete,
  type DirEntry,
  listDir,
} from "../api/client.js";
import { showMenu } from "./contextMenu.js";
import { showCreateForm } from "./createDialog.js";
import type { Viewer } from "./fileTree.js";
import { reloadOpenTabs, resetDeletedTabBuffers } from "./tabsView.js";

/** Locate the `<li>` for a directory (by rel) in the current tree DOM. */
export function findDirLi(
  list: HTMLUListElement,
  rel: string,
): HTMLLIElement | null {
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
          el.querySelector(".name")?.textContent === part,
      ) as HTMLLIElement | undefined) ?? null;
    if (!found) return null;
    current = found.querySelector(":scope > ul");
  }
  return found;
}

export async function renderListing(
  list: HTMLUListElement,
  lsPath: HTMLElement,
  rel: string,
  viewer: Viewer,
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
  viewer: Viewer,
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
      () => void expandDir(toggle, li, childRel, viewer),
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
              void viewer.cb.viewFile(
                childRel ? `${childRel}/${name}` : name,
                viewer,
              );
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
    row.addEventListener(
      "click",
      () => void viewer.cb.viewFile(childRel, viewer),
    );
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
  viewer: Viewer,
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
    // Mark the buffer of whichever tab had this file loaded clean, so the
    // delete's own watch event doesn't flag it out-of-date.
    resetDeletedTabBuffers(viewer, rel);
    viewer.cb.setHint(viewer, `Deleted "${name}".`, "viewer-hint");
  } catch (err) {
    viewer.cb.setHint(
      viewer,
      `Delete failed: ${(err as Error).message}`,
      "viewer-error",
    );
  }
}

async function expandDir(
  toggle: HTMLButtonElement,
  li: HTMLLIElement,
  rel: string,
  viewer: Viewer,
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

export async function refreshDir(
  viewer: Viewer,
  rel: string,
  targetLi: HTMLLIElement | null,
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

/**
 * Debounced live-refresh: on a filesystem change, refresh the root plus every
 * expanded directory, and reload the open file in the viewer (only when its
 * buffer is clean, so a user mid-edit is never clobbered). A short timer
 * collapses the burst of events a single edit typically produces.
 */
let liveRefreshTimer: ReturnType<typeof setTimeout> | undefined;
export function scheduleLiveRefresh(viewer: Viewer, e: { path: string }): void {
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
    (a, b) => a.split("/").length - b.split("/").length,
  );
  for (const dirRel of dirs) {
    const li = findDirLi(viewer.list, dirRel);
    if (li) await refreshDir(viewer, dirRel, li);
  }

  // Reload every open tab whose file changed on disk. The per-tab logic lives
  // in `tabsView.ts`'s `reloadOpenTabs` (active-tab reload goes through the
  // injected `loadIntoViewer` callback; background tabs reload in place).
  await reloadOpenTabs(viewer, rel, viewer.cb);
}
