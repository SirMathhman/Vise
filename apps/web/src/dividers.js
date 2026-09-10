/**
 * Sets up draggable vertical dividers between the layout columns.
 * @param {HTMLElement} appEl - The app root element.
 */
export function setupDividers(appEl) {
  const layout = appEl.querySelector(".layout");
  const treeEl = appEl.querySelector(".tree-container");
  const chatEl = appEl.querySelector(".chat");

  for (const divider of appEl.querySelectorAll(".divider")) {
    divider.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const isTree = divider.dataset.target === "tree";
      const colEl = isTree ? treeEl : chatEl;
      const prop = isTree ? "--tree-width" : "--chat-width";
      const startX = e.clientX;
      const startPx = colEl.getBoundingClientRect().width;

      const onMove = (e) => {
        const delta = e.clientX - startX;
        const raw = isTree ? startPx + delta : startPx - delta;
        const newWidth = Math.max(150, Math.min(600, raw));
        layout.style.setProperty(prop, `${newWidth}px`);
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
    });

    divider.addEventListener("keydown", (e) => {
      const isTree = divider.dataset.target === "tree";
      const prop = isTree ? "--tree-width" : "--chat-width";
      const colEl = isTree ? treeEl : chatEl;
      const current = colEl.getBoundingClientRect().width;
      const step = e.shiftKey ? 40 : 10;
      const delta =
        e.key === "ArrowLeft"
          ? isTree
            ? -step
            : step
          : e.key === "ArrowRight"
            ? isTree
              ? step
              : -step
            : 0;
      if (delta === 0) return;
      e.preventDefault();
      const newWidth = Math.max(150, Math.min(600, current + delta));
      layout.style.setProperty(prop, `${newWidth}px`);
    });
  }
}
