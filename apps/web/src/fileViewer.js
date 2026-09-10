import { fetchFileContent } from "./api.js";
import { renderLines } from "./render.js";
import { getOpenFilePath, setOpenFilePath } from "./state.js";

/**
 * Sets up the file viewer: attaches the click handler for file entries,
 * renders fetched content with line numbers, and animates content in when
 * the model edits the file that is currently open.
 * @param {HTMLElement} appEl - The app root element (for event delegation).
 */
export function setupFileViewer(appEl) {
  const viewerEl = appEl.querySelector("#file-viewer");
  let streamTimer = null; // cleanup handle for the in-flight stream

  appEl.addEventListener("click", async (e) => {
    const fileEntry = e.target.closest(".entry.file");
    if (!fileEntry) return;

    const path = fileEntry.dataset.path;
    const headerEl = viewerEl.querySelector(".file-viewer-header");
    const codeEl = viewerEl.querySelector(".file-viewer-content code");

    stopStream();
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

  // When the model writes a file, animate the new content in if it's the
  // file currently open in the viewer.
  appEl.addEventListener("file-edit", (e) => {
    const { path, content } = e.detail ?? {};
    if (typeof path !== "string" || typeof content !== "string") return;
    if (path !== getOpenFilePath()) return;
    const codeEl = viewerEl.querySelector(".file-viewer-content code");
    streamLines(codeEl, content);
  });

  function stopStream() {
    if (streamTimer) {
      clearTimeout(streamTimer);
      streamTimer = null;
    }
    viewerEl.classList.remove("editing");
    viewerEl
      .querySelector(".file-viewer-content code")
      ?.classList.remove("streaming");
  }

  function streamLines(codeEl, content) {
    stopStream();
    renderLines(codeEl, content);
    viewerEl.classList.add("editing");

    const lines = codeEl.querySelectorAll(".line");
    // Stagger the per-line reveal so the content reads as streaming in from
    // the top, without ever taking too long for large files.
    const perLine = Math.min(15, 1200 / Math.max(lines.length, 1));
    for (const [i, line] of lines.entries()) {
      line.style.animationDelay = `${i * perLine}ms`;
    }
    codeEl.classList.add("streaming");

    const total = lines.length * perLine + 250;
    streamTimer = setTimeout(() => {
      codeEl.classList.remove("streaming");
      viewerEl.classList.remove("editing");
      streamTimer = null;
    }, total);
  }
}
