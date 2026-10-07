interface DirEntry {
  name: string;
  dir: boolean;
}

interface OpenFile {
  path: string;
  text: string;
}

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
): { open(path: string): Promise<void> } {
  const files: OpenFile[] = [];
  let active = -1;

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
        entry.dir ? dirRow(entry.name, child) : fileRow(entry.name, child),
      );
    }
  }

  function fileRow(name: string, path: string): HTMLLIElement {
    const item = document.createElement("li");
    item.className = "fs-row";
    item.dataset.path = path;
    item.classList.toggle(
      "open",
      files.some((f) => f.path === path),
    );
    item.textContent = name;
    item.addEventListener("click", () => void openFile(path));
    return item;
  }

  /** A collapsible directory: click toggles; children load on first expand. */
  function dirRow(name: string, path: string): HTMLLIElement {
    const item = document.createElement("li");
    const head = document.createElement("div");
    head.className = "fs-row fs-dir";
    head.textContent = `▸ ${name}`;
    const children = document.createElement("ul");
    children.className = "fs-children hidden";
    let loaded = false;
    head.addEventListener("click", () => {
      const expand = children.classList.contains("hidden");
      children.classList.toggle("hidden", !expand);
      head.textContent = `${expand ? "▾" : "▸"} ${name}`;
      if (expand && !loaded) {
        loaded = true;
        void open(path, children);
      }
    });
    item.append(head, children);
    return item;
  }

  async function openFile(path: string): Promise<void> {
    const existing = files.findIndex((f) => f.path === path);
    if (existing >= 0) return activate(existing);
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    const body: unknown = await res.json();
    const text =
      typeof body === "string"
        ? body
        : ((body as { error?: string }).error ?? "error");
    files.push({ path, text });
    activate(files.length - 1);
    markOpen();
  }

  function activate(index: number): void {
    active = index;
    viewer.textContent = files[index]?.text ?? "";
    renderTabs();
  }

  function close(index: number): void {
    files.splice(index, 1);
    if (files.length === 0) active = -1;
    else if (active > index || active >= files.length) active--;
    viewer.textContent = files[active]?.text ?? "";
    renderTabs();
    markOpen();
  }

  function renderTabs(): void {
    drawTabs(tabs, files, active, activate, close);
  }

  /** Re-highlight tree rows after the open set changes. */
  function markOpen(): void {
    for (const row of list.querySelectorAll<HTMLElement>("[data-path]")) {
      row.classList.toggle(
        "open",
        files.some((f) => f.path === row.dataset.path),
      );
    }
  }

  return { open };
}

/** Fetch a directory's entries, showing loading/error/empty messages in `ul`; null when there is nothing to list. */
async function fetchEntries(
  path: string,
  ul: HTMLUListElement,
): Promise<DirEntry[] | null> {
  showMessage(ul, "Loading…", "loading");
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
    tabs.appendChild(tab);
  });
}
