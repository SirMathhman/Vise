import type { BrowserView } from "./browser-view.ts";
import { type BrowserTab, OpenTabs, type OpenFile } from "./open-tabs.ts";
import { showMenu } from "./tab-menu.ts";

interface DirEntry {
  name: string;
  dir: boolean;
}

/** Extra viewer pieces: rendered markdown, its toggle, the URL iframe and its form. */
interface MarkdownView {
  mdView: HTMLElement;
  frame: HTMLIFrameElement;
  urlForm: HTMLFormElement;
  /** Address bar for the active URL tab; navigates that tab in place. */
  addrForm: HTMLFormElement;
  modeBtn: HTMLButtonElement;
  /** Pane holding the integrated browser's live view, and its controller. */
  pane: HTMLElement;
  browser: BrowserView;
  renderMarkdown(source: string): string;
}

const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path);

/**
 * Read-only file workspace over `/api/fs` and `/api/file`, rooted at the
 * server's working directory: a directory tree plus a tab strip so several
 * files stay open at once. Clicking a file opens (or focuses) its tab;
 * middle-click or × closes it.
 */
export function createExplorer(
  pathEl: HTMLElement,
  list: HTMLUListElement,
  tabs: HTMLElement,
  viewer: HTMLPreElement,
  md: MarkdownView,
): {
  open(path: string): Promise<void>;
  reload(): Promise<void>;
  /** Mirror the integrated browser's tabs; true when a new one appeared. */
  syncBrowserTabs(tabs: BrowserTab[]): boolean;
} {
  const set = new OpenTabs();
  /** Directories the user has expanded; kept so a refresh restores them. */
  const expanded = new Set<string>();

  /** Fill `ul` with the entries of directory `path` (lazy; called on first expand). */
  async function open(
    path: string,
    ul: HTMLUListElement = list,
  ): Promise<void> {
    const entries = await fetchEntries(path, ul);
    if (!entries) return;
    pathEl.textContent = "/";
    for (const entry of entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      ul.appendChild(
        entry.dir
          ? dirRow(entry.name, child, expanded, (c) => void open(child, c))
          : fileRow(
              entry.name,
              child,
              set.has(child),
              () => void openFile(child),
            ),
      );
    }
  }

  /** Open a URL as a tab that renders the page in an iframe. */
  function openUrl(raw: string): void {
    const url = normalizeUrl(raw);
    if (url) activate(set.urlIndex(url));
  }

  bindUrlForm(md.urlForm, openUrl, true);
  bindUrlForm(
    md.addrForm,
    (raw) => navigateTab(set.current, raw, md) && redraw(),
    false,
  );

  async function openFile(path: string): Promise<void> {
    const existing = set.indexOf(path);
    if (existing >= 0) return activate(existing);
    const text = (await readFile(path)) ?? "unable to read file";
    const mode = isMarkdown(path) ? "markdown" : "text";
    activate(set.add({ path, text, mode }));
  }

  function activate(index: number): void {
    set.active = index;
    redraw();
  }

  function redraw(): void {
    renderViewer(set.current, viewer, md);
    drawTabs(tabs, set.files, set.active, activate, close, tabMenu);
    markOpen();
  }

  /** Keep only tabs where `keep(i)` holds; closing a browser tab also closes it for real. */
  function retain(keep: (i: number) => boolean): void {
    for (const gone of set.retain(keep)) {
      if (gone.mode === "browser") md.browser.close(browserId(gone));
    }
    redraw();
  }

  function close(index: number): void {
    retain((i) => i !== index);
  }

  function tabMenu(index: number, x: number, y: number): void {
    showMenu(x, y, [
      { label: "Close all", run: () => retain(() => false) },
      {
        label: "Close all to right",
        disabled: index === set.files.length - 1,
        run: () => retain((i) => i <= index),
      },
    ]);
  }

  md.modeBtn.addEventListener("click", () => {
    if (toggleMode(set.current)) renderViewer(set.current, viewer, md);
  });

  /** Re-highlight tree rows after the open set changes. */
  function markOpen(): void {
    for (const row of list.querySelectorAll<HTMLElement>("[data-path]")) {
      row.classList.toggle("open", set.has(row.dataset.path ?? ""));
    }
  }

  function syncBrowserTabs(browserTabs: BrowserTab[]): boolean {
    const added = set.sync(browserTabs);
    redraw();
    return added;
  }

  /** Re-list the tree (keeping expanded folders) and re-read every open file. */
  async function reload(): Promise<void> {
    void open("");
    await rereadFiles(set.files);
    renderViewer(set.current, viewer, md);
  }

  return { open, reload, syncBrowserTabs };
}

/** Fetch a directory's entries, showing loading/error/empty messages in `ul`; null when there is nothing to list. */
async function fetchEntries(
  path: string,
  ul: HTMLUListElement,
): Promise<DirEntry[] | null> {
  // On a refresh the old rows stay until the new ones arrive (no flicker).
  if (ul.childElementCount === 0) showMessage(ul, "Loading…", "loading");
  try {
    const res = await fetch(`/api/fs?path=${encodeURIComponent(path)}`);
    const body = (await res.json()) as {
      entries?: DirEntry[];
      error?: string;
    };
    if (!res.ok || !body.entries) {
      showMessage(ul, body.error ?? "Unable to read this directory.", "error");
      return null;
    }
    if (body.entries.length === 0) {
      showMessage(ul, "Empty directory.", "empty");
      return null;
    }
    ul.textContent = "";
    return body.entries;
  } catch {
    showMessage(ul, "Unable to load this directory.", "error");
    return null;
  }
}

function showMessage(
  list: HTMLUListElement,
  text: string,
  state: "loading" | "empty" | "error",
): void {
  const item = document.createElement("li");
  item.className = `fs-message ${state}`;
  item.setAttribute("role", state === "error" ? "alert" : "status");
  item.textContent = text;
  list.replaceChildren(item);
}

function drawTabs(
  tabs: HTMLElement,
  files: OpenFile[],
  active: number,
  onActivate: (i: number) => void,
  onClose: (i: number) => void,
  onMenu: (i: number, x: number, y: number) => void,
): void {
  tabs.textContent = "";
  files.forEach((file, i) => {
    const tab = document.createElement("div");
    tab.className = i === active ? "fs-tab active" : "fs-tab";
    tab.title = file.path;
    tab.setAttribute("role", "tab");
    tab.append(tabLabel(file));
    const x = document.createElement("button");
    x.className = "fs-tab-close";
    x.textContent = "×";
    x.title = "close";
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      onClose(i);
    });
    tab.appendChild(x);
    tab.addEventListener("click", () => onActivate(i));
    tab.addEventListener("auxclick", (e) => {
      if (e.button === 1) onClose(i);
    });
    tab.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      onMenu(i, e.clientX, e.clientY);
    });
    tabs.appendChild(tab);
  });
}

/** Show a file as text or rendered markdown, and sync the mode toggle. */
function renderViewer(
  file: OpenFile | undefined,
  viewer: HTMLPreElement,
  md: MarkdownView,
): void {
  const rendered = file?.mode === "markdown";
  const url = file?.mode === "url";
  const live = file?.mode === "browser";
  viewer.textContent = url || live ? "" : (file?.text ?? "");
  viewer.classList.toggle("hidden", rendered || url || live);
  md.mdView.classList.toggle("hidden", !rendered);
  md.frame.classList.toggle("hidden", !url);
  md.pane.classList.toggle("hidden", !live);
  md.addrForm.classList.toggle("hidden", !url && !live);
  if (file && (url || live))
    showAddress(md.addrForm, url ? file.path : file.text);
  if (file && rendered) md.mdView.innerHTML = md.renderMarkdown(file.text);
  // Only (re)load the frame when its target changes, so tab switches don't reset the page.
  if (file && url && md.frame.getAttribute("src") !== file.path) {
    md.frame.setAttribute("src", file.path);
  }
  if (!url && md.frame.hasAttribute("src")) md.frame.removeAttribute("src");
  if (file && live) md.browser.show(browserId(file));
  else md.browser.hide();
  md.modeBtn.classList.toggle(
    "hidden",
    !file || url || live || !isMarkdown(file.path),
  );
  md.modeBtn.textContent = rendered ? "view text" : "view markdown";
}

/** The browser tab number behind a `browser:<id>` workspace tab. */
function browserId(file: OpenFile): number {
  return Number(file.path.slice("browser:".length));
}

/** Show an address in the bar unless the user is typing in it. */
function showAddress(form: HTMLFormElement, address: string): void {
  const input = form.elements.namedItem("url") as HTMLInputElement;
  if (document.activeElement !== input) input.value = address;
}

/** Add a scheme when missing: http for local hosts, https otherwise. Null if not a valid URL. */
function normalizeUrl(raw: string): string | null {
  const text = raw.trim();
  if (!text) return null;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text);
  const full = /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
    ? text
    : `${local ? "http" : "https"}://${text}`;
  try {
    return new URL(full).href;
  } catch {
    return null;
  }
}

function fileRow(
  name: string,
  path: string,
  isOpen: boolean,
  onOpen: () => void,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "fs-row";
  item.dataset.path = path;
  item.classList.toggle("open", isOpen);
  item.textContent = name;
  item.addEventListener("click", onOpen);
  return item;
}

/** A collapsible directory: click toggles; `load` fills the children on first expand. */
function dirRow(
  name: string,
  path: string,
  expanded: Set<string>,
  load: (children: HTMLUListElement) => void,
): HTMLLIElement {
  const item = document.createElement("li");
  const head = document.createElement("div");
  head.className = "fs-row fs-dir";
  head.textContent = `▸ ${name}`;
  const children = document.createElement("ul");
  children.className = "fs-children hidden";
  let loaded = false;
  const setOpen = (open: boolean): void => {
    children.classList.toggle("hidden", !open);
    head.textContent = `${open ? "▾" : "▸"} ${name}`;
    if (open) expanded.add(path);
    else expanded.delete(path);
    if (open && !loaded) {
      loaded = true;
      load(children);
    }
  };
  head.addEventListener("click", () =>
    setOpen(children.classList.contains("hidden")),
  );
  if (expanded.has(path)) setOpen(true);
  item.append(head, children);
  return item;
}

/** Read a file's text through the API; null when it cannot be read. */
async function readFile(path: string): Promise<string | null> {
  try {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    const body: unknown = await res.json();
    if (typeof body === "string") return body;
    return (body as { error?: string }).error ?? null;
  } catch {
    return null;
  }
}

/** Call `onOpen` with the typed URL when the form is submitted, then clear the field. */
function bindUrlForm(
  form: HTMLFormElement,
  onOpen: (url: string) => unknown,
  clear: boolean,
): void {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const input = form.elements.namedItem("url") as HTMLInputElement;
    onOpen(input.value);
    if (clear) input.value = "";
  });
}

/** Refresh the text of every open file tab from disk (URL tabs are left alone). */
async function rereadFiles(files: OpenFile[]): Promise<void> {
  await Promise.all(
    files.map(async (file) => {
      if (file.mode === "url" || file.mode === "browser") return;
      const text = await readFile(file.path);
      if (text !== null) file.text = text;
    }),
  );
}

/** Point a URL or browser tab at a new address in place. False when nothing needs redrawing. */
function navigateTab(
  file: OpenFile | undefined,
  raw: string,
  md: MarkdownView,
): boolean {
  const url = normalizeUrl(raw);
  if (!url || !file) return false;
  if (file.mode === "browser") {
    md.browser.navigate(browserId(file), url);
    return false;
  }
  if (file.mode !== "url") return false;
  file.path = url;
  // Setting src explicitly also reloads when the address is unchanged.
  md.frame.setAttribute("src", url);
  return true;
}

/** Flip a file between text and rendered markdown. False for URL tabs or no tab. */
function toggleMode(file: OpenFile | undefined): boolean {
  if (!file || file.mode === "url" || file.mode === "browser") return false;
  file.mode = file.mode === "markdown" ? "text" : "markdown";
  return true;
}

/** What a tab is called: a page's host/title, or a file's base name. */
function tabLabel(file: OpenFile): string {
  if (file.mode === "url") return new URL(file.path).host;
  if (file.mode === "browser") return file.title || file.text || "browser";
  return file.path.slice(file.path.lastIndexOf("/") + 1);
}
