import { renderListing } from "./render.js";

/**
 * Fetches the file/directory listing for a given path from the backend and
 * renders it into the provided element.
 */
export async function loadListing(targetEl, path = "") {
  targetEl.innerHTML = '<p class="status">Loading…</p>';

  try {
    const url = path ? `/api/listing?path=${encodeURIComponent(path)}` : "/api/listing";
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const entries = await res.json();
    renderListing(targetEl, entries, path);
  } catch (err) {
    targetEl.innerHTML = `<p class="status error">Could not load listing: ${err.message}</p>`;
  }
}
