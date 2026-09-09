import { renderTree, renderChildren } from "./render.js";

/**
 * Fetches directory entries for a given path from the backend.
 * @param {string} path - The relative path to list.
 * @returns {Promise<Array<{name: string, isDirectory: boolean}>>}
 */
export async function fetchEntries(path = "") {
  const url = path
    ? `/api/listing?path=${encodeURIComponent(path)}`
    : "/api/listing";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

/**
 * Sets up the tree: attaches the expand/collapse click handler and loads
 * the root listing.
 * @param {HTMLElement} appEl - The app root element (for event delegation).
 */
export function setupTree(appEl) {
  const treeEl = appEl.querySelector("#tree");

  appEl.addEventListener("click", async (e) => {
    const toggle = e.target.closest(".toggle");
    if (!toggle) return;
    e.preventDefault();

    const li = toggle.closest("li.dir");
    const path = li.dataset.path;
    const expanded = toggle.getAttribute("aria-expanded") === "true";

    if (expanded) {
      const children = li.querySelector(":scope > ul.children");
      if (children) children.remove();
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "▸";
    } else {
      let children = li.querySelector(":scope > ul.children");
      if (!children) {
        toggle.textContent = "…";
        try {
          const entries = await fetchEntries(path);
          renderChildren(li, entries, path);
        } catch {
          toggle.textContent = "✕";
          return;
        }
      }
      toggle.setAttribute("aria-expanded", "true");
      toggle.textContent = "▾";
    }
  });

  loadRoot(treeEl);
}

/**
 * Loads the root directory listing and renders it as a tree.
 * @param {HTMLElement} treeEl - The tree container element.
 */
async function loadRoot(treeEl) {
  treeEl.innerHTML = '<p class="status">Loading…</p>';
  try {
    const entries = await fetchEntries();
    renderTree(treeEl, entries, "");
  } catch (err) {
    treeEl.innerHTML = `<p class="status error">Could not load listing: ${err.message}</p>`;
  }
}
