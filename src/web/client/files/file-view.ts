import type { FileView } from "../state.ts";

// What the viewer shows: the files the session has open, and the one whose text is shown.
export interface FileShown {
  openFiles: string[];
  file?: FileView;
}

// What the viewer asks the page to do: show an open file, or close it.
export interface FileActions {
  showFile(path: string): void;
  closeFile(path: string): void;
}

// The viewer: a row of tabs, one per open file, and the text of the shown file. It is hidden while no file is open.
export interface FileViewer {
  element: HTMLElement;
  update(shown: FileShown): void;
}

export function createFileViewer(doc: Document, actions: FileActions): FileViewer {
  const element = doc.createElement("section");
  element.className = "file-viewer";
  element.hidden = true;
  let key = "";
  return {
    element,
    update(shown) {
      const next = JSON.stringify(shown);
      if (next === key) return;
      key = next;
      element.hidden = shown.openFiles.length === 0;
      const tabs = doc.createElement("div");
      tabs.className = "file-tabs";
      for (const path of shown.openFiles) {
        tabs.append(tabOf(doc, path, shown.file?.path === path, actions));
      }
      const body = doc.createElement("pre");
      body.textContent = shown.file?.text ?? "loading…";
      element.replaceChildren(tabs, body);
    },
  };
}

// One open file: a tab that shows it, and a button that closes it.
function tabOf(doc: Document, path: string, selected: boolean, actions: FileActions): HTMLElement {
  const tab = doc.createElement("span");
  tab.className = selected ? "file-tab selected" : "file-tab";
  const name = doc.createElement("button");
  name.type = "button";
  name.className = "file-tab-name";
  name.textContent = path;
  name.setAttribute("aria-pressed", String(selected));
  name.addEventListener("click", () => actions.showFile(path));
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "file-tab-close";
  close.textContent = "×";
  close.setAttribute("aria-label", `Close ${path}`);
  close.addEventListener("click", () => actions.closeFile(path));
  tab.append(name, close);
  return tab;
}
