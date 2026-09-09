import { renderListing } from "./render.js";

/**
 * Fetches the top-level file/directory listing from the backend and renders it
 * into the provided element.
 */
export async function loadListing(targetEl) {
  targetEl.innerHTML = '<p class="status">Loading…</p>';

  try {
    const res = await fetch("/api/listing");
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const names = await res.json();
    renderListing(targetEl, names);
  } catch (err) {
    targetEl.innerHTML = `<p class="status error">Could not load listing: ${err.message}</p>`;
  }
}
