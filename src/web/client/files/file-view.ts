import type { FileView } from "../state.ts";

// The viewer for one file: a panel beside the tree that shows its text. It shows the file the page gets, and
// its Close button hides it; a click on another file, or the same file again, shows it again.
export interface FileViewer {
  element: HTMLElement;
  update(file: FileView | undefined): void;
}

export function createFileViewer(doc: Document): FileViewer {
  const element = doc.createElement("section");
  element.className = "file-viewer";
  element.hidden = true;
  let shown: FileView | undefined;
  return {
    element,
    update(file) {
      if (file === undefined || file === shown) return;
      shown = file;
      const heading = doc.createElement("h2");
      heading.textContent = file.path;
      const close = doc.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => {
        element.hidden = true;
      });
      const body = doc.createElement("pre");
      body.textContent = file.text;
      element.replaceChildren(heading, close, body);
      element.hidden = false;
    },
  };
}
