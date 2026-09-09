import { renderTree } from "./render.js";

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
 * Loads the root directory listing and renders it as a tree.
 * @param {HTMLElement} treeEl - The tree container element.
 */
export async function loadRoot(treeEl) {
  treeEl.innerHTML = '<p class="status">Loading…</p>';
  try {
    const entries = await fetchEntries();
    renderTree(treeEl, entries, "");
  } catch (err) {
    treeEl.innerHTML = `<p class="status error">Could not load listing: ${err.message}</p>`;
  }
}
