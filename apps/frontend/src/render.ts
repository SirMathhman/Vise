interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

interface LsResponse {
  path: string;
  items: DirEntry[];
}

interface FileResponse {
  path: string;
  size: number;
  content: string;
}

export async function render(root: HTMLElement): Promise<void> {
  root.innerHTML = `
    <main>
      <h1>Vise</h1>
      <p class="tagline">File &amp; Directory Viewer</p>
      <div class="status-row">
        <p id="status">Fetching backend status&hellip;</p>
      </div>
      <div class="layout">
        <section id="listing">
          <h2>Contents of <code id="ls-path"></code></h2>
          <ul id="ls-items" aria-label="files and directories"></ul>
        </section>
        <section id="viewer">
          <h2 id="viewer-title">File contents</h2>
          <pre id="viewer-body"><span class="viewer-hint">Select a file to view its contents.</span></pre>
        </section>
      </div>
    </main>
  `;
  const status = root.querySelector<HTMLParagraphElement>("#status");
  const lsPath = root.querySelector<HTMLElement>("#ls-path");
  const list = root.querySelector<HTMLUListElement>("#ls-items");
  const viewerBody = root.querySelector<HTMLPreElement>("#viewer-body");
  const viewerTitle = root.querySelector<HTMLHeadingElement>("#viewer-title");
  if (!status || !lsPath || !list || !viewerBody || !viewerTitle) return;

  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { status: string };
    status.textContent = `Backend: ${data.status}`;
    status.classList.add("ok");
  } catch (err) {
    status.textContent = `Backend: unreachable (${(err as Error).message})`;
    status.classList.add("err");
  }

  const viewer: Viewer = { body: viewerBody, title: viewerTitle };
  await renderListing(list, lsPath, "", viewer);
}

interface Viewer {
  body: HTMLPreElement;
  title: HTMLHeadingElement;
}

async function fetchListing(rel: string): Promise<LsResponse> {
  const res = await fetch(`/api/ls/${encodeRel(rel)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as LsResponse;
}

function encodeRel(rel: string): string {
  return rel.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

async function renderListing(
  list: HTMLUListElement,
  lsPath: HTMLElement,
  rel: string,
  viewer: Viewer
): Promise<void> {
  try {
    const data = await fetchListing(rel);
    if (rel === "") lsPath.textContent = data.path;
    list.innerHTML = "";
    for (const item of data.items) {
      list.append(renderEntry(item, rel, viewer));
    }
  } catch (err) {
    list.innerHTML = "";
    const li = document.createElement("li");
    li.className = "error";
    li.textContent = `Failed to load: ${(err as Error).message}`;
    list.append(li);
  }
}

function renderEntry(
  item: DirEntry,
  parentRel: string,
  viewer: Viewer
): HTMLLIElement {
  const li = document.createElement("li");
  li.className = item.kind;
  const row = document.createElement("div");
  row.className = "row";

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = item.kind === "directory" ? "dir" : "file";

  const name = document.createElement("span");
  name.className = "name";
  name.textContent = item.name;

  const childRel = parentRel ? `${parentRel}/${item.name}` : item.name;

  if (item.kind === "directory") {
    const toggle = document.createElement("button");
    toggle.className = "toggle";
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "▸";
    toggle.addEventListener(
      "click",
      () => void expandDir(toggle, li, childRel, viewer)
    );
    row.append(toggle, badge, name);
  } else {
    row.classList.add("clickable");
    row.addEventListener("click", () => void viewFile(childRel, viewer));
    row.append(badge, name);
  }

  li.append(row);
  return li;
}

async function viewFile(rel: string, viewer: Viewer): Promise<void> {
  viewer.title.textContent = rel;
  viewer.body.innerHTML = `<span class="loading">Loading&hellip;</span>`;
  try {
    const res = await fetch(`/api/file/${encodeRel(rel)}`);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(data?.message ?? `HTTP ${res.status}`);
    }
    const data = (await res.json()) as FileResponse;
    viewer.title.textContent = data.path;
    renderFileContent(viewer.body, data.content);
  } catch (err) {
    viewer.body.innerHTML = "";
    const span = document.createElement("span");
    span.className = "viewer-error";
    span.textContent = `Failed to load: ${(err as Error).message}`;
    viewer.body.append(span);
  }
}

function renderFileContent(body: HTMLPreElement, content: string): void {
  body.innerHTML = "";
  const lines = content.split(/\r?\n/);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < lines.length; i++) {
    const line = document.createElement("div");
    line.className = "line";
    const no = document.createElement("span");
    no.className = "line-no";
    no.textContent = String(i + 1);
    const text = document.createElement("span");
    text.className = "line-text";
    text.textContent = lines[i];
    line.append(no, text);
    frag.append(line);
  }
  body.append(frag);
}

async function expandDir(
  toggle: HTMLButtonElement,
  li: HTMLLIElement,
  rel: string,
  viewer: Viewer
): Promise<void> {
  const expanded = toggle.getAttribute("aria-expanded") === "true";
  if (expanded) {
    toggle.textContent = "▸";
    toggle.setAttribute("aria-expanded", "false");
    const existing = li.querySelector(":scope > ul");
    if (existing) existing.remove();
    return;
  }

  toggle.textContent = "▾";
  toggle.setAttribute("aria-expanded", "true");
  const existing = li.querySelector(":scope > ul");
  if (existing) {
    existing.remove();
    return;
  }

  const childList = document.createElement("ul");
  childList.className = "children";
  childList.setAttribute("aria-label", `${rel} contents`);
  li.append(childList);
  await renderListing(childList, li, rel, viewer);
}
