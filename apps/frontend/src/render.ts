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
import { setupLlm } from "./components/llm.js";
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
        <section id="llm">
          <h2>Model</h2>
          <div class="llm-controls">
            <select id="llm-model" aria-label="model"></select>
            <button id="llm-send" class="btn" type="button">Send</button>
            <button
              id="llm-clear"
              class="btn btn-ghost"
              type="button"
              title="Start a new conversation"
            >
              Clear
            </button>
          </div>
          <textarea
            id="llm-prompt"
            aria-label="message"
            placeholder="Ask about the files, e.g. what's in apps/backend"
          ></textarea>
          <div id="llm-response">
            <span class="llm-hint">Start a conversation.</span>
          </div>
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
  setupLlm(root);
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
  saveTimer?: number;
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
  clearSaveTimer(viewer);
  await flushSave(viewer);
  if (viewer.dirty) {
    // The pending save failed; abort so edits are not lost.
    return;
  }
  viewer.title.textContent = rel;
  viewer.actions.innerHTML = "";
  setHint(viewer.body, "Loading\u2026", "loading");
  try {
    const data = await getFile(rel);
    viewer.title.textContent = data.path;
    viewer.content = data.content;
    viewer.rel = rel;
    renderEditor(viewer);
  } catch (err) {
    setHint(
      viewer.body,
      `Failed to load: ${(err as Error).message}`,
      "viewer-error"
    );
  }
}

function renderEditor(viewer: Viewer): void {
  clearSaveTimer(viewer);
  viewer.actions.innerHTML = "";
  const text = viewer.content ?? "";

  // A transparent-text textarea sits on top of a live-highlighted backdrop.
  // Both share identical font metrics (inherited from .editor-scroll) and
  // no wrapping, so the colored text lines up exactly with the edited text.
  const scroller = document.createElement("div");
  scroller.className = "editor-scroll";
  const grid = document.createElement("div");
  grid.className = "editor-grid";
  const gutter = document.createElement("div");
  gutter.className = "editor-gutter";
  gutter.setAttribute("aria-hidden", "true");
  const code = document.createElement("div");
  code.className = "editor-code";
  const backdrop = document.createElement("pre");
  backdrop.className = "editor-backdrop";
  const ta = document.createElement("textarea");
  ta.className = "editor-input";
  ta.spellcheck = false;
  ta.setAttribute("aria-label", "file contents");

  const paint = (): void => {
    const lines = ta.value.split(/\r?\n/);
    const gut = document.createDocumentFragment();
    const back = document.createDocumentFragment();
    for (let i = 0; i < lines.length; i++) {
      const no = document.createElement("span");
      no.className = "line-no";
      no.textContent = String(i + 1);
      gut.append(no);
      const line = document.createElement("div");
      line.className = "line";
      const lineText = document.createElement("span");
      lineText.className = "line-text";
      appendHighlighted(lineText, lines[i]);
      line.append(lineText);
      back.append(line);
    }
    gutter.textContent = "";
    gutter.append(gut);
    backdrop.textContent = "";
    backdrop.append(back);
  };

  ta.value = text;
  paint();
  viewer.dirty = false;
  ta.addEventListener("input", () => {
    paint();
    viewer.dirty = true;
    setSaveState(viewer, "unsaved");
    scheduleAutoSave(viewer);
  });

  code.append(backdrop, ta);
  grid.append(gutter, code);
  scroller.append(grid);
  // .editor-scroll is the sole scroller in edit mode; suppress the
  // #viewer-body scroll so only one scrollbar shows.
  viewer.body.style.overflow = "hidden";
  // Drop the read-only rendering first: the editor is absolutely
  // positioned over #viewer-body, so anything left behind shows through
  // as a second, misaligned copy of the text.
  viewer.body.innerHTML = "";
  viewer.body.append(scroller);
  ta.focus();
}

const AUTOSAVE_MS = 1000;

function scheduleAutoSave(viewer: Viewer): void {
  clearSaveTimer(viewer);
  viewer.saveTimer = window.setTimeout(() => {
    viewer.saveTimer = undefined;
    void saveFile(viewer);
  }, AUTOSAVE_MS);
}

function clearSaveTimer(viewer: Viewer): void {
  if (viewer.saveTimer !== undefined) {
    window.clearTimeout(viewer.saveTimer);
    viewer.saveTimer = undefined;
  }
}

async function flushSave(viewer: Viewer): Promise<void> {
  clearSaveTimer(viewer);
  if (!viewer.dirty || !viewer.rel) return;
  const ta = viewer.body.querySelector<HTMLTextAreaElement>(".editor-input");
  const next = ta?.value;
  if (next === undefined) return;
  try {
    await putFile(viewer.rel, next);
    viewer.content = next;
    viewer.dirty = false;
  } catch (err) {
    // Keep dirty so the caller aborts and beforeunload fires; surface the
    // failure so the user knows why navigation is blocked.
    setSaveState(viewer, "error", (err as Error).message);
  }
}

async function saveFile(viewer: Viewer): Promise<void> {
  clearSaveTimer(viewer);
  const ta = viewer.body.querySelector<HTMLTextAreaElement>(".editor-input");
  if (!ta || !viewer.rel) return;
  const next = ta.value;
  if (next === (viewer.content ?? "")) {
    viewer.dirty = false;
    setSaveState(viewer, "saved");
    return;
  }
  setSaveState(viewer, "saving");
  try {
    await putFile(viewer.rel, next);
    viewer.content = next;
    viewer.dirty = false;
    setSaveState(viewer, "saved");
  } catch (err) {
    viewer.dirty = true;
    setSaveState(viewer, "error", (err as Error).message);
  }
}

function setSaveState(
  viewer: Viewer,
  state: "unsaved" | "saving" | "saved" | "error",
  message?: string
): void {
  let span = viewer.actions.querySelector<HTMLElement>(".save-status");
  if (!span) {
    span = document.createElement("span");
    span.className = "save-status";
    viewer.actions.append(span);
  }
  span.className = `save-status save-status-${state}`;
  span.textContent =
    state === "unsaved"
      ? "\u25CF unsaved"
      : state === "saving"
        ? "saving\u2026"
        : state === "saved"
          ? "saved"
          : `save failed${message ? `: ${message}` : ""}`;
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
