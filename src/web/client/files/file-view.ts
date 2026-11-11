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
  saveFile(path: string, text: string, base: string): void;
}

// The viewer: a row of tabs, one per open file, and the text of the shown file in an editor, with line numbers. What is
// typed is saved a moment after the typing stops. A Markdown file can also show a rendered preview above its editor.
export interface FileViewer {
  element: HTMLElement;
  update(shown: FileShown): void;
}

// The time after the last keystroke before a typed text is saved.
const SAVE_DELAY_MS = 1000;

// What the viewer keeps beyond the shown file: which Markdown files show their preview, the typed text of each, the text
// last saved, the version each file was last seen at, the text each file was last seen with, whether each uses Windows
// line ends, and the save that is waiting.
interface EditState {
  actions: FileActions;
  preview: Set<string>;
  drafts: Map<string, string>;
  saved: Map<string, string>;
  versions: Map<string, string>;
  texts: Map<string, string>;
  crlf: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
}

export function createFileViewer(doc: Document, actions: FileActions): FileViewer {
  const element = doc.createElement("section");
  element.className = "file-viewer";
  element.hidden = true;
  const state: EditState = {
    actions,
    preview: new Set(),
    drafts: new Map(),
    saved: new Map(),
    versions: new Map(),
    texts: new Map(),
    crlf: new Set(),
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
      const file = next.file;
      if (file !== undefined) remember(file, state);
      // A refused save echoes the file's own text, which differs from what was sent. When the file's text has changed
      // and is not what was sent, forget that save, so the next flush sends the draft again, now with the new version.
      if (file !== undefined) forgetRefused(file, state);
      // A save echoing back must not rebuild the editor, or the cursor would move.
      if (file !== undefined && state.saved.get(file.path) === lf(file.text)) return;
      draw();
    },
  };
}

// The shown file's body: a Markdown file's toolbar and optional preview, then its editor.
function bodyOf(doc: Document, file: FileView | undefined, state: EditState, redraw: () => void): HTMLElement[] {
  if (file === undefined) return [preOf(doc, "loading…")];
  const path = file.path;
  const text = state.drafts.get(path) ?? file.text;
  const parts: HTMLElement[] = [];
  if (isMarkdown(path)) {
    parts.push(toolbarOf(doc, path, state, redraw));
    if (state.preview.has(path)) parts.push(previewOf(doc, text));
  }
  parts.push(editorOf(doc, path, text, state));
  return parts;
}

// The Preview button of a Markdown file. The preview shows above the editor; the editor stays.
function toolbarOf(doc: Document, path: string, state: EditState, redraw: () => void): HTMLElement {
  const bar = doc.createElement("div");
  bar.className = "file-toolbar";
  const previewing = state.preview.has(path);
  bar.append(
    buttonOf(doc, previewing ? "Hide preview" : "Preview", () => {
      if (previewing) state.preview.delete(path);
      else state.preview.add(path);
      redraw();
    }),
  );
  return bar;
}

function previewOf(doc: Document, text: string): HTMLElement {
  const view = doc.createElement("div");
  view.className = "file-markdown";
  view.append(...renderMarkdown(doc, text));
  return view;
}

// The editor: the text in a box that grows with it, beside its line numbers. The numbers are not selectable, so
// copying the text copies only the text. Each keystroke schedules a save.
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

// Keeps what a save needs from a file the page has been sent: its version, and whether it uses Windows line ends.
function remember(file: FileView, state: EditState): void {
  if (file.version !== undefined) state.versions.set(file.path, file.version);
  if (file.text.includes("\r\n")) state.crlf.add(file.path);
  else state.crlf.delete(file.path);
}

// Forgets the last save of a file when the file's text has changed since the page last saw it and is not what was sent.
function forgetRefused(file: FileView, state: EditState): void {
  const text = lf(file.text);
  const before = state.texts.get(file.path);
  state.texts.set(file.path, text);
  if (before !== undefined && before !== text && state.saved.get(file.path) !== text) state.saved.delete(file.path);
}

// The text with Unix line ends, as a text area holds it.
function lf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Saves the path's typed text now, unless that exact text was the last one saved. A save names the version it is based
// on, and a file that uses Windows line ends keeps them.
function flush(path: string, state: EditState): void {
  clearTimeout(state.timers.get(path));
  state.timers.delete(path);
  const text = state.drafts.get(path);
  const base = state.versions.get(path);
  if (text === undefined || base === undefined || state.saved.get(path) === text) return;
  state.saved.set(path, text);
  const outgoing = state.crlf.has(path) ? text.replace(/\n/g, "\r\n") : text;
  state.actions.saveFile(path, outgoing, base);
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
    state.preview.delete(path);
    state.actions.closeFile(path);
  });
  tab.append(name, close);
  return tab;
}
