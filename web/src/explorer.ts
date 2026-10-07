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

  async function open(path: string): Promise<void> {
    await loadDirectory(
      path,
      pathEl,
      list,
      addRow,
      (child) => void open(child),
      (child) => void openFile(child),
    );
  }

  function addRow(
    name: string,
    path: string,
    dir: boolean,
    onClick: () => void,
  ): void {
    const item = document.createElement("li");
    item.className = "fs-row";
    if (!dir && files.some((f) => f.path === path)) item.classList.add("open");
    item.textContent = dir ? `${name}/` : name;
    item.addEventListener("click", onClick);
    list.appendChild(item);
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
    for (const row of list.querySelectorAll<HTMLElement>(".fs-row")) {
      const name = (row.textContent ?? "").replace(/\/$/, "");
      const dir =
        pathEl.textContent === "/"
          ? ""
          : (pathEl.textContent ?? "").slice(1) + "/";
      row.classList.toggle(
        "open",
        files.some((f) => f.path === dir + name),
      );
    }
  }

  return { open };
}

async function loadDirectory(
  path: string,
  pathEl: HTMLElement,
  list: HTMLUListElement,
  addRow: (
    name: string,
    path: string,
    dir: boolean,
    onClick: () => void,
  ) => void,
  openDirectory: (path: string) => void,
  openFile: (path: string) => void,
): Promise<void> {
  list.textContent = "";
  showMessage(list, "Loading…", "loading");
  let entries: DirEntry[];
  try {
    const res = await fetch(`/api/fs?path=${encodeURIComponent(path)}`);
    const body = (await res.json()) as {
      entries?: DirEntry[];
      error?: string;
    };
    if (!res.ok || !body.entries) {
      showMessage(
        list,
        body.error ?? "Unable to read this directory.",
        "error",
      );
      return;
    }
    entries = body.entries;
  } catch {
    showMessage(list, "Unable to load this directory.", "error");
    return;
  }

  pathEl.textContent = `/${path}`;
  list.textContent = "";
  if (path) addRow("..", "", true, () => openDirectory(parentOf(path)));
  if (entries.length === 0) {
    showMessage(list, "No files or folders in this directory.", "empty");
    return;
  }
  for (const entry of entries) {
    const child = path ? `${path}/${entry.name}` : entry.name;
    addRow(entry.name, child, entry.dir, () =>
      entry.dir ? openDirectory(child) : openFile(child),
    );
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

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
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
