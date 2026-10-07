interface DirEntry {
  name: string;
  dir: boolean;
}

/** Read-only file browser over `/api/fs` and `/api/file`, rooted at the server's working directory. */
export function createExplorer(
  pathEl: HTMLElement,
  list: HTMLUListElement,
  viewer: HTMLPreElement,
): { open(path: string): Promise<void> } {
  async function open(path: string): Promise<void> {
    const res = await fetch(`/api/fs?path=${encodeURIComponent(path)}`);
    const body = (await res.json()) as { entries?: DirEntry[]; error?: string };
    list.textContent = "";
    viewer.classList.add("hidden");
    if (!res.ok || !body.entries) {
      list.appendChild(document.createElement("li")).textContent =
        body.error ?? "error";
      return;
    }
    pathEl.textContent = `/${path}`;
    if (path) addRow("..", true, () => void open(parentOf(path)));
    for (const entry of body.entries) {
      const child = path ? `${path}/${entry.name}` : entry.name;
      addRow(
        entry.name,
        entry.dir,
        () => void (entry.dir ? open(child) : view(child)),
      );
    }
  }

  function addRow(name: string, dir: boolean, onClick: () => void): void {
    const item = document.createElement("li");
    item.className = "fs-row";
    item.textContent = dir ? `${name}/` : name;
    item.addEventListener("click", onClick);
    list.appendChild(item);
  }

  async function view(path: string): Promise<void> {
    const res = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
    const body: unknown = await res.json();
    viewer.textContent =
      typeof body === "string"
        ? body
        : ((body as { error?: string }).error ?? "error");
    viewer.classList.remove("hidden");
    pathEl.textContent = `/${path}`;
  }

  return { open };
}

function parentOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}
