import { showMenu } from "./tab-menu.ts";

interface DirEntry {
  name: string;
  dir: boolean;
}

interface OpenFile {
  path: string;
  text: string;
  /** Markdown files can show rendered or as raw text. */
  mode: "text" | "markdown";
}

/** Markdown rendering pieces: the rendered view, the toggle button, the renderer. */
interface MarkdownView {
  mdView: HTMLElement;
  modeBtn: HTMLButtonElement;
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
): { open(path: string): Promise<void>; reload(): Promise<void> } {
  const files: OpenFile[] = [];
  let active = -1;
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
              files.some((f) => f.path === child),
              () => void openFile(child),
            ),
      );
    }
  }

  async function openFile(path: string): Promise<void> {
    const existing = files.findIndex((f) => f.path === path);
    if (existing >= 0) return activate(existing);
    const text = (await readFile(path)) ?? "unable to read file";
    files.push({ path, text, mode: isMarkdown(path) ? "markdown" : "text" });
    activate(files.length - 1);
  }

  function activate(index: number): void {
    active = index;
    redraw();
  }

  function redraw(): void {
    showActive();
    drawTabs(tabs, files, active, activate, close, tabMenu);
    markOpen();
  }

  function close(index: number): void {
    retain((i) => i !== index);
  }

  /** Keep only tabs where `keep(i)` holds. Focus stays on its tab if it survives, else moves to the nearest survivor. */
  function retain(keep: (i: number) => boolean): void {
    const focused = files[active];
    const kept = files.filter((_, i) => keep(i));
    const old = active;
    files.splice(0, files.length, ...kept);
    active =
      focused && kept.includes(focused)
        ? kept.indexOf(focused)
        : Math.min(old, kept.length - 1);
    redraw();
  }

  function tabMenu(index: number, x: number, y: number): void {
    showMenu(x, y, [
      { label: "Close all", run: () => retain(() => false) },
      {
        label: "Close all to right",
        disabled: index === files.length - 1,
        run: () => retain((i) => i <= index),
      },
    ]);
  }

  function showActive(): void {
    renderViewer(files[active], viewer, md);
  }

  md.modeBtn.addEventListener("click", () => {
    const file = files[active];
    if (!file) return;
    file.mode = file.mode === "markdown" ? "text" : "markdown";
    showActive();
  });

  /** Re-highlight tree rows after the open set changes. */
  function markOpen(): void {
    for (const row of list.querySelectorAll<HTMLElement>("[data-path]")) {
      row.classList.toggle(
        "open",
        files.some((f) => f.path === row.dataset.path),
      );
    }
  }

  /** Re-list the tree (keeping expanded folders) and re-read every open file. */
  async function reload(): Promise<void> {
    void open("");
    await Promise.all(
      files.map(async (file) => {
        const text = await readFile(file.path);
        if (text !== null) file.text = text;
      }),
    );
    renderViewer(files[active], viewer, md);
  }

  return { open, reload };
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
    tab.append(file.path.slice(file.path.lastIndexOf("/") + 1));
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
  viewer.textContent = file?.text ?? "";
  viewer.classList.toggle("hidden", rendered);
  md.mdView.classList.toggle("hidden", !rendered);
  if (file && rendered) md.mdView.innerHTML = md.renderMarkdown(file.text);
  md.modeBtn.classList.toggle("hidden", !file || !isMarkdown(file.path));
  md.modeBtn.textContent = rendered ? "view text" : "view markdown";
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
