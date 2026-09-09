/**
 * Renders the page shell (heading + listing container) into the app element.
 */
export function renderApp(appEl) {
  appEl.innerHTML = `
  <main class="page">
    <h1>Top-level files &amp; directories</h1>
    <div id="listing" class="listing-container"></div>
  </main>
`;
}

/**
 * Renders the top-level file/directory listing into the provided element.
 */
export function renderListing(targetEl, names) {
  if (!names.length) {
    targetEl.innerHTML = '<p class="status">No entries found.</p>';
    return;
  }
  const items = names
    .map((name) => `<li class="entry">${escapeHtml(name)}</li>`)
    .join("");
  targetEl.innerHTML = `<ul class="listing">${items}</ul>`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
