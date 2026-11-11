import type { FileView } from "../state.ts";

// The viewer for one file: a dialog that shows its text. It opens when the page gets a new file, and
// closes with its Close button.
export interface FileViewer {
  dialog: HTMLDialogElement;
  update(file: FileView | undefined): void;
}

export function createFileViewer(doc: Document): FileViewer {
  const dialog = doc.createElement("dialog");
  dialog.className = "file-viewer";
  let shown: FileView | undefined;
  return {
    dialog,
    update(file) {
      if (file === undefined || file === shown) return;
      shown = file;
      const heading = doc.createElement("h2");
      heading.textContent = file.path;
      const close = doc.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => dialog.close());
      const body = doc.createElement("pre");
      body.textContent = file.text;
      dialog.replaceChildren(heading, close, body);
      dialog.showModal();
    },
  };
}
