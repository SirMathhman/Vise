import { appendHighlighted } from "./highlight.js";

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
          <div id="viewer-actions"></div>
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
  const viewerActions = root.querySelector<HTMLElement>("#viewer-actions");
  if (
    !status ||
    !lsPath ||
    !list ||
    !viewerBody ||
    !viewerTitle ||
    !viewerActions
  )
    return;

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

  const menu = makeContextMenu();
  const viewer: Viewer = {
    body: viewerBody,
    title: viewerTitle,
    actions: viewerActions,
    menu,
    list,
    lsPath,
  };
  window.addEventListener("beforeunload", (e: BeforeUnloadEvent) => {
    if (viewer.dirty) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
  list.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    showMenu(viewer.menu, e.clientX, e.clientY, [
      {
        label: "New File",
        onClick: () => showCreateForm(viewer, "file", "", null),
      },
      {
        label: "New Directory",
        onClick: () => showCreateForm(viewer, "directory", "", null),
      },
    ]);
  });
  await renderListing(list, lsPath, "", viewer);
}

interface Viewer {
  body: HTMLPreElement;
  title: HTMLHeadingElement;
  actions: HTMLElement;
  menu: HTMLDivElement;
  list: HTMLUListElement;
  lsPath: HTMLElement;
  content?: string;
  rel?: string;
  dirty?: boolean;
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
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(viewer.menu, e.clientX, e.clientY, [
        {
          label: "New File",
          onClick: () => showCreateForm(viewer, "file", childRel, li),
        },
        {
          label: "New Directory",
          onClick: () => showCreateForm(viewer, "directory", childRel, li),
        },
      ]);
    });
    row.append(toggle, badge, name);
  } else {
    row.classList.add("clickable");
    row.addEventListener("click", () => void viewFile(childRel, viewer));
    row.append(badge, name);
  }

  li.append(row);
  return li;
}

function setHint(
  body: HTMLPreElement,
  text: string,
  cls = "viewer-hint"
): void {
  body.innerHTML = "";
  const span = document.createElement("span");
  span.className = cls;
  span.textContent = text;
  body.append(span);
}

function makeButton(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.className = "btn";
  btn.type = "button";
  btn.textContent = label;
  btn.addEventListener("click", onClick);
  return btn;
}

async function viewFile(rel: string, viewer: Viewer): Promise<void> {
  if (viewer.dirty) {
    const ok = window.confirm("Discard unsaved changes?");
    if (!ok) return;
    viewer.dirty = false;
  }
  viewer.title.textContent = rel;
  viewer.actions.innerHTML = "";
  setHint(viewer.body, "Loading\u2026", "loading");
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
    viewer.content = data.content;
    viewer.rel = rel;
    renderReadonly(viewer);
  } catch (err) {
    setHint(
      viewer.body,
      `Failed to load: ${(err as Error).message}`,
      "viewer-error"
    );
  }
}

function renderReadonly(viewer: Viewer): void {
  viewer.dirty = false;
  viewer.actions.innerHTML = "";
  viewer.actions.append(makeButton("Edit", () => renderEditor(viewer)));
  renderHighlighted(viewer.body, viewer.content ?? "");
}

function renderEditor(viewer: Viewer, value?: string): void {
  viewer.dirty = false;
  viewer.actions.innerHTML = "";
  viewer.actions.append(
    makeButton("Cancel", () => {
      if (viewer.dirty) {
        const ok = window.confirm("Discard unsaved changes?");
        if (!ok) return;
      }
      renderReadonly(viewer);
    })
  );
  viewer.actions.append(makeButton("Save", () => void saveFile(viewer)));
  const unsaved = document.createElement("span");
  unsaved.className = "unsaved";
  unsaved.textContent = "\u25CF unsaved";
  viewer.actions.append(unsaved);

  viewer.body.innerHTML = "";
  const ta = document.createElement("textarea");
  ta.className = "editor";
  ta.spellcheck = false;
  ta.setAttribute("aria-label", "file contents");
  ta.value = value ?? viewer.content ?? "";
  viewer.dirty = ta.value !== (viewer.content ?? "");
  unsaved.hidden = !viewer.dirty;
  ta.addEventListener("input", () => {
    viewer.dirty = ta.value !== (viewer.content ?? "");
    unsaved.hidden = !viewer.dirty;
  });
  viewer.body.append(ta);
}

function renderHighlighted(body: HTMLPreElement, content: string): void {
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
    appendHighlighted(text, lines[i]);
    line.append(no, text);
    frag.append(line);
  }
  body.append(frag);
}

async function saveFile(viewer: Viewer): Promise<void> {
  const ta = viewer.body.querySelector<HTMLTextAreaElement>(".editor");
  if (!ta || !viewer.rel) return;
  const original = viewer.content ?? "";
  const next = ta.value;
  viewer.actions.innerHTML = "";
  viewer.actions.append(makeButton("Saving\u2026", () => {}));
  try {
    const res = await fetch(`/api/file/${encodeRel(viewer.rel)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: next }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        message?: string;
      } | null;
      throw new Error(data?.message ?? `HTTP ${res.status}`);
    }
    viewer.content = next;
    renderReadonly(viewer);
  } catch (err) {
    viewer.content = original;
    renderEditor(viewer, next);
    setSaveError(viewer, (err as Error).message);
  }
}

function setSaveError(viewer: Viewer, message: string): void {
  const span = document.createElement("span");
  span.className = "viewer-error";
  span.textContent = `Save failed: ${message}`;
  viewer.actions.append(span);
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

interface MenuItem {
  label: string;
  onClick: () => void;
}

function makeContextMenu(): HTMLDivElement {
  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  document.addEventListener("click", () => hideMenu(menu));
  document.addEventListener("contextmenu", () => hideMenu(menu));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu(menu);
  });
  window.addEventListener("blur", () => hideMenu(menu));
  window.addEventListener("resize", () => hideMenu(menu));
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  return menu;
}

function hideMenu(menu: HTMLDivElement): void {
  menu.hidden = true;
}

function showMenu(
  menu: HTMLDivElement,
  x: number,
  y: number,
  items: MenuItem[]
): void {
  menu.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      hideMenu(menu);
      item.onClick();
    });
    menu.append(btn);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 6);
  const py = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(6, px)}px`;
  menu.style.top = `${Math.max(6, py)}px`;
}

function showCreateForm(
  viewer: Viewer,
  kind: "file" | "directory",
  parentRel: string,
  targetLi: HTMLLIElement | null
): void {
  const overlay = document.createElement("div");
  overlay.className = "create-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");

  const form = document.createElement("form");
  form.className = "create-form";

  const title = document.createElement("h3");
  title.textContent = kind === "directory" ? "New directory" : "New file";

  const where = document.createElement("p");
  where.className = "create-where";
  where.textContent = `Create in: ${parentRel || "(root)"}`;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "create-input";
  input.placeholder = "name";
  input.autocomplete = "off";

  const error = document.createElement("p");
  error.className = "create-error";
  error.hidden = true;

  const row = document.createElement("div");
  row.className = "create-row";
  const cancel = makeButton("Cancel", () => overlay.remove());
  const create = makeButton("Create", () => {
    void submit();
  });
  row.append(cancel, create);

  form.append(title, where, input, error, row);
  overlay.append(form);
  document.body.append(overlay);
  input.focus();
  input.select();

  async function submit(): Promise<void> {
    const name = input.value.trim();
    if (!name) {
      showError("Please enter a name.");
      input.focus();
      return;
    }
    if (name.includes("/") || name.includes("\\")) {
      showError("The name cannot contain a slash.");
      input.focus();
      return;
    }
    create.disabled = true;
    try {
      await createEntry(kind, parentRel, name, () => {
        overlay.remove();
        void refreshDir(viewer, parentRel, targetLi);
        if (kind === "file")
          void viewFile(`${parentRel ? `${parentRel}/${name}` : name}`, viewer);
      });
    } catch (err) {
      create.disabled = false;
      showError((err as Error).message);
      input.focus();
    }
  }

  function showError(msg: string): void {
    error.textContent = msg;
    error.hidden = false;
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    void submit();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape") overlay.remove();
    },
    { once: true }
  );
}

async function createEntry(
  kind: "file" | "directory",
  parentRel: string,
  name: string,
  onSuccess: () => void
): Promise<void> {
  const rel = parentRel ? `${parentRel}/${name}` : name;
  const endpoint = kind === "directory" ? "/api/dir" : "/api/file";
  const payload =
    kind === "directory" ? { path: rel } : { path: rel, content: "" };
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      message?: string;
    } | null;
    throw new Error(data?.message ?? `HTTP ${res.status}`);
  }
  onSuccess();
}

async function refreshDir(
  viewer: Viewer,
  rel: string,
  targetLi: HTMLLIElement | null
): Promise<void> {
  if (!targetLi) {
    await renderListing(viewer.list, viewer.lsPath, "", viewer);
    return;
  }
  const toggle = targetLi.querySelector<HTMLButtonElement>(".toggle");
  if (toggle) {
    toggle.textContent = "▾";
    toggle.setAttribute("aria-expanded", "true");
  }
  let childList = targetLi.querySelector<HTMLUListElement>(":scope > ul");
  if (!childList) {
    childList = document.createElement("ul");
    childList.className = "children";
    childList.setAttribute("aria-label", `${rel} contents`);
    targetLi.append(childList);
  }
  await renderListing(childList, targetLi, rel, viewer);
}
