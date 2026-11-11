import type { FileView } from "../state.ts";
import { renderMarkdown } from "../render/markdown-dom.ts";

// What the viewer shows: the files the session has open, and the one whose text is shown.
export interface FileShown {
  openFiles: string[];
  file?: FileView;
}

// What the viewer asks the page to do: show an open file, close it, or save its text.
export interface FileActions {
  showFile(path: string): void;
  closeFile(path: string): void;
  saveFile(path: string, text: string): void;
}

// The viewer: a row of tabs, one per open file, and the text of the shown file, with line numbers. A text file can be
// edited in place; what is typed is saved a moment after the typing stops. A Markdown file opens rendered.
export interface FileViewer {
  element: HTMLElement;
  update(shown: FileShown): void;
}

// The time after the last keystroke before a typed text is saved.
const SAVE_DELAY_MS = 1000;

// What the viewer keeps beyond the shown file: which files are being edited or shown as source, the typed text of each,
// the text last saved, and the save that is waiting.
interface EditState {
  actions: FileActions;
  editing: Set<string>;
  source: Set<string>;
  drafts: Map<string, string>;
  saved: Map<string, string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
}

export function createFileViewer(doc: Document, actions: FileActions): FileViewer {
  const element = doc.createElement("section");
  element.className = "file-viewer";
  element.hidden = true;
  const state: EditState = {
    actions,
    editing: new Set(),
    source: new Set(),
    drafts: new Map(),
    saved: new Map(),
    timers: new Map(),
  };
  let key = "";
  let shown: FileShown = { openFiles: [] };

  function draw(): void {
    element.hidden = shown.openFiles.length === 0;
    const tabs = doc.createElement("div");
    tabs.className = "file-tabs";
    for (const path of shown.openFiles) {
      tabs.append(tabOf(doc, path, shown.file?.path === path, state));
    }
    element.replaceChildren(tabs, ...bodyOf(doc, shown.file, state, draw));
  }

  return {
    element,
    update(next) {
      const nextKey = JSON.stringify(next);
      if (nextKey === key) return;
      key = nextKey;
      shown = next;
      // A save echoing back while its file is being typed in must not rebuild the editor, or the cursor would move.
      const file = next.file;
      if (file !== undefined && state.editing.has(file.path) && state.saved.get(file.path) === file.text) return;
      draw();
    },
  };
}

// The shown file's body: its text with line numbers, the editor, or its rendered Markdown, under its toolbar.
function bodyOf(doc: Document, file: FileView | undefined, state: EditState, redraw: () => void): HTMLElement[] {
  if (file === undefined) return [preOf(doc, "loading…")];
  const path = file.path;
  const text = state.drafts.get(path) ?? file.text;
  const toolbar = toolbarOf(doc, path, state, redraw);
  if (isMarkdown(path) && !state.source.has(path) && !state.editing.has(path)) {
    const view = doc.createElement("div");
    view.className = "file-markdown";
    view.append(...renderMarkdown(doc, text));
    return [toolbar, view];
  }
  const body = state.editing.has(path) ? editorOf(doc, path, text, state) : numberedOf(doc, text);
  return [toolbar, body];
}

// The buttons above the body: Source or Rendered for a Markdown file, and Edit or Done for any text file.
function toolbarOf(doc: Document, path: string, state: EditState, redraw: () => void): HTMLElement {
  const bar = doc.createElement("div");
  bar.className = "file-toolbar";
  if (isMarkdown(path)) {
    const source = state.source.has(path);
    bar.append(
      buttonOf(doc, source ? "Rendered" : "Source", () => {
        if (source) state.source.delete(path);
        else state.source.add(path);
        redraw();
      }),
    );
  }
  const editing = state.editing.has(path);
  bar.append(
    buttonOf(doc, editing ? "Done" : "Edit", () => {
      if (editing) {
        state.editing.delete(path);
        flush(path, state);
      } else {
        state.editing.add(path);
      }
      redraw();
    }),
  );
  return bar;
}

// The text with its line numbers beside it. The numbers are not selectable, so copying the text copies only the text.
function numberedOf(doc: Document, text: string): HTMLElement {
  const body = doc.createElement("div");
  body.className = "file-body";
  const code = doc.createElement("pre");
  code.className = "file-code";
  code.textContent = text;
  body.append(gutterOf(doc, text), code);
  return body;
}

// The editor: the text in a box that grows with it, beside its line numbers. Each keystroke schedules a save.
function editorOf(doc: Document, path: string, text: string, state: EditState): HTMLElement {
  const body = doc.createElement("div");
  body.className = "file-body";
  const gutter = gutterOf(doc, text);
  const area = doc.createElement("textarea");
  area.className = "file-code file-editor";
  area.spellcheck = false;
  area.value = text;
  area.addEventListener("input", () => {
    state.drafts.set(path, area.value);
    gutter.textContent = lineNumbers(area.value);
    schedule(path, state);
  });
  body.append(gutter, area);
  return body;
}

function gutterOf(doc: Document, text: string): HTMLElement {
  const gutter = doc.createElement("div");
  gutter.className = "file-gutter";
  gutter.setAttribute("aria-hidden", "true");
  gutter.textContent = lineNumbers(text);
  return gutter;
}

// "1" to the number of lines in the text, one per line.
function lineNumbers(text: string): string {
  return Array.from({ length: text.split("\n").length }, (_, index) => String(index + 1)).join("\n");
}

// Saves the path's typed text after the typing stops.
function schedule(path: string, state: EditState): void {
  clearTimeout(state.timers.get(path));
  state.timers.set(path, setTimeout(() => flush(path, state), SAVE_DELAY_MS));
}

// Saves the path's typed text now, unless that exact text was the last one saved.
function flush(path: string, state: EditState): void {
  clearTimeout(state.timers.get(path));
  state.timers.delete(path);
  const text = state.drafts.get(path);
  if (text === undefined || state.saved.get(path) === text) return;
  state.saved.set(path, text);
  state.actions.saveFile(path, text);
}

function isMarkdown(path: string): boolean {
  return /\.md$/i.test(path);
}

function preOf(doc: Document, text: string): HTMLElement {
  const pre = doc.createElement("pre");
  pre.textContent = text;
  return pre;
}

function buttonOf(doc: Document, label: string, onClick: () => void): HTMLButtonElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "file-mode";
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

// One open file: a tab that shows it, and a button that closes it. Closing saves what was typed first.
function tabOf(doc: Document, path: string, selected: boolean, state: EditState): HTMLElement {
  const tab = doc.createElement("span");
  tab.className = selected ? "file-tab selected" : "file-tab";
  const name = doc.createElement("button");
  name.type = "button";
  name.className = "file-tab-name";
  name.textContent = path;
  name.setAttribute("aria-pressed", String(selected));
  name.addEventListener("click", () => state.actions.showFile(path));
  const close = doc.createElement("button");
  close.type = "button";
  close.className = "file-tab-close";
  close.textContent = "×";
  close.setAttribute("aria-label", `Close ${path}`);
  close.addEventListener("click", () => {
    flush(path, state);
    state.drafts.delete(path);
    state.saved.delete(path);
    state.editing.delete(path);
    state.source.delete(path);
    state.actions.closeFile(path);
  });
  tab.append(name, close);
  return tab;
}
