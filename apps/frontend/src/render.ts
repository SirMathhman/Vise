import {
  deleteFile as apiDelete,
  type DirEntry,
  getFile,
  health,
  listDir,
  putFile,
} from "./api/client.js";
import { makeContextMenu, showMenu } from "./components/contextMenu.js";
import { showCreateForm } from "./components/createDialog.js";
import { makeButton } from "./dom.js";
import { appendHighlighted } from "./highlight.js";

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
    const st = await health();
    status.textContent = `Backend: ${st}`;
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
        onClick: () =>
          showCreateForm("file", "", (name) => {
            void refreshDir(viewer, "", null);
            void viewFile(name, viewer);
          }),
      },
      {
        label: "New Directory",
        onClick: () =>
          showCreateForm("directory", "", () => {
            void refreshDir(viewer, "", null);
          }),
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

async function renderListing(
  list: HTMLUListElement,
  lsPath: HTMLElement,
  rel: string,
  viewer: Viewer
): Promise<void> {
  try {
    const data = await listDir(rel);
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
          onClick: () =>
            showCreateForm("file", childRel, (name) => {
              void refreshDir(viewer, childRel, li);
              void viewFile(childRel ? `${childRel}/${name}` : name, viewer);
            }),
        },
        {
          label: "New Directory",
          onClick: () =>
            showCreateForm("directory", childRel, () => {
              void refreshDir(viewer, childRel, li);
            }),
        },
      ]);
    });
    row.append(toggle, badge, name);
  } else {
    row.classList.add("clickable");
    row.addEventListener("click", () => void viewFile(childRel, viewer));
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showMenu(viewer.menu, e.clientX, e.clientY, [
        {
          label: "Delete",
          onClick: () => void deleteFile(childRel, parentRel, li, viewer),
        },
      ]);
    });
    row.append(badge, name);
  }

  li.append(row);
  return li;
}

async function deleteFile(
  rel: string,
  parentRel: string,
  li: HTMLLIElement,
  viewer: Viewer
): Promise<void> {
  const name = rel.split("/").pop() ?? rel;
  const ok = window.confirm(`Delete "${name}"? This cannot be undone.`);
  if (!ok) return;
  try {
    await apiDelete(rel);
    if (parentRel === "") {
      await renderListing(viewer.list, viewer.lsPath, "", viewer);
    } else {
      const parentLi = li.parentElement?.parentElement;
      if (parentLi instanceof HTMLLIElement) {
        await refreshDir(viewer, parentRel, parentLi);
      }
    }
    viewer.dirty = false;
    setHint(viewer.body, `Deleted "${name}".`, "viewer-hint");
  } catch (err) {
    setHint(
      viewer.body,
      `Delete failed: ${(err as Error).message}`,
      "viewer-error"
    );
  }
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
    const data = await getFile(rel);
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
    await putFile(viewer.rel, next);
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
