/**
 * Fetches the text content of a file from the backend.
 * @param {string} path - The file's relative path.
 * @returns {Promise<string>} The file's text content.
 */
export async function fetchFileContent(path) {
  const url = `/api/file?path=${encodeURIComponent(path)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Request failed: ${res.status}`);
  }
  const data = await res.json();
  return data.content;
}

/**
 * Sets up the file viewer: attaches the click handler for file entries and
 * renders fetched content with line numbers.
 * @param {HTMLElement} appEl - The app root element (for event delegation).
 */
export function setupFileViewer(appEl) {
  const viewerEl = appEl.querySelector("#file-viewer");

  appEl.addEventListener("click", async (e) => {
    const fileEntry = e.target.closest(".entry.file");
    if (!fileEntry) return;

    const path = fileEntry.dataset.path;
    const headerEl = viewerEl.querySelector(".file-viewer-header");
    const codeEl = viewerEl.querySelector(".file-viewer-content code");

    headerEl.textContent = path;
    codeEl.textContent = "Loading…";

    try {
      const content = await fetchFileContent(path);
      renderLines(codeEl, content);
    } catch (err) {
      codeEl.textContent = `Could not load file: ${err.message}`;
    }
  });
}

/**
 * Renders file content with line numbers into a <code> element.
 * @param {HTMLElement} codeEl - The <code> element to fill.
 * @param {string} text - The file's text content.
 */
function renderLines(codeEl, text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  codeEl.replaceChildren();
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const row = document.createElement("span");
    row.className = "line";

    const num = document.createElement("span");
    num.className = "line-num";
    num.textContent = String(i + 1);

    const code = document.createElement("span");
    code.className = "line-code";
    code.textContent = lines[i];

    row.append(num, code);
    frag.appendChild(row);
  }
  codeEl.appendChild(frag);
}
