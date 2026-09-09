/**
 * Renders the page shell (heading + breadcrumb + listing container) into the app element.
 */
export function renderApp(appEl) {
  appEl.innerHTML = `
  <main class="page">
    <h1>Files &amp; directories</h1>
    <nav id="breadcrumb" class="breadcrumb"></nav>
    <div id="listing" class="listing-container"></div>
  </main>
`;
}

/**
 * Renders the breadcrumb navigation for the current path.
 * @param {HTMLElement} targetEl - The breadcrumb nav element.
 * @param {string} path - The current relative path (e.g. "apps/server").
 */
export function renderBreadcrumb(targetEl, path) {
  const parts = path ? path.split("/") : [];
  let html = `<a href="#" data-path="">root</a>`;
  let accumulated = "";
  for (const part of parts) {
    accumulated += (accumulated ? "/" : "") + part;
    html += `<span class="sep">/</span><a href="#" data-path="${escapeHtml(accumulated)}">${escapeHtml(part)}</a>`;
  }
  targetEl.innerHTML = html;
}

/**
 * Renders the file/directory listing into the provided element.
 * @param {HTMLElement} targetEl - The listing container element.
 * @param {Array<{name: string, isDirectory: boolean}>} entries - Directory entries.
 * @param {string} path - The current relative path (for building child paths).
 */
export function renderListing(targetEl, entries, path = "") {
  if (!entries.length) {
    targetEl.innerHTML = '<p class="status">No entries found.</p>';
    return;
  }
  const items = entries
    .map((entry) => {
      const childPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        return `<li class="entry dir"><a href="#" data-path="${escapeHtml(childPath)}">${escapeHtml(entry.name)}/</a></li>`;
      }
      return `<li class="entry file">${escapeHtml(entry.name)}</li>`;
    })
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
