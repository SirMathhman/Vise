import { fetchFileContent } from "./api.js";
import { renderLines } from "./render.js";
import { setOpenFilePath } from "./state.js";

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
    setOpenFilePath(path);
    codeEl.textContent = "Loading…";

    try {
      const content = await fetchFileContent(path);
      renderLines(codeEl, content);
    } catch (err) {
      codeEl.textContent = `Could not load file: ${err.message}`;
    }
  });
}
