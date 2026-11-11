import type { FileView } from "../state.ts";
import { renderMarkdown } from "../render/markdown-dom.ts";

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

// The viewer: a row of tabs, one per open file, and the text of the shown file. A Markdown file (.md) opens
// rendered, with a button that switches to its source text. It is hidden while no file is open.
export interface FileViewer {
  element: HTMLElement;
  update(shown: FileShown): void;
}

export function createFileViewer(doc: Document, actions: FileActions): FileViewer {
  const element = doc.createElement("section");
  element.className = "file-viewer";
  element.hidden = true;
  // The Markdown files the user has switched to their source text.
  const source = new Set<string>();
  let key = "";
  let shown: FileShown = { openFiles: [] };

  function draw(): void {
    element.hidden = shown.openFiles.length === 0;
    const tabs = doc.createElement("div");
    tabs.className = "file-tabs";
    for (const path of shown.openFiles) {
      tabs.append(tabOf(doc, path, shown.file?.path === path, actions));
    }
    element.replaceChildren(tabs, ...bodyOf());
  }

  // The shown file's body: its rendered Markdown, its source, or its text as it is.
  function bodyOf(): HTMLElement[] {
    const file = shown.file;
    if (file === undefined) return [preOf(doc, "loading…")];
    if (!isMarkdown(file.path)) return [preOf(doc, file.text)];
    const raw = source.has(file.path);
    const toggle = doc.createElement("button");
    toggle.type = "button";
    toggle.className = "file-mode";
    toggle.textContent = raw ? "Rendered" : "Source";
    toggle.addEventListener("click", () => {
      if (raw) source.delete(file.path);
      else source.add(file.path);
      draw();
    });
    if (raw) return [toggle, preOf(doc, file.text)];
    const rendered = doc.createElement("div");
    rendered.className = "file-markdown";
    rendered.append(...renderMarkdown(doc, file.text));
    return [toggle, rendered];
  }

  return {
    element,
    update(next) {
      const nextKey = JSON.stringify(next);
      if (nextKey === key) return;
      key = nextKey;
      shown = next;
      draw();
    },
  };
}

function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

function preOf(doc: Document, text: string): HTMLElement {
  const pre = doc.createElement("pre");
  pre.textContent = text;
  return pre;
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
