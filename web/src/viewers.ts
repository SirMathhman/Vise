// The file viewers beside the chat: the open files as tabs, and the blocks of each file that are loaded.

const viewers = document.getElementById("viewers") as HTMLElement;
const viewersTabs = document.getElementById("viewers-tabs") as HTMLDivElement;
const viewersBody = document.getElementById("viewers-body") as HTMLDivElement;
const viewersCloseAll = document.getElementById("viewers-close-all") as HTMLButtonElement;

// The file viewers beside the chat, as tabs: one file shows at a time. A file's lines arrive in blocks, and Load more
// fetches the next block. Nothing scrolls inside the viewer; the column does. A file is open once, under its path.
interface Viewed {
  path: string;
  lines: string[];
  next: number;
  more: boolean;
  loading: boolean;
  error: string | null;
  // Whether the file is shown as markdown rather than as its raw text.
  rendered: boolean;
}

const viewed: Viewed[] = [];
let activePath: string | null = null;

// Whether a file is markdown, which opens rendered and can be switched to its raw text.
function isMarkdown(path: string): boolean {
  return path.toLowerCase().endsWith(".md");
}

function renderViewers(): void {
  viewers.hidden = viewed.length === 0;
  viewersPanel.divider.hidden = viewers.hidden;
  applyPanelWidths();
  viewersTabs.replaceChildren(
    ...viewed.map((file) => {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = file.path === activePath ? "viewer-tab active" : "viewer-tab";
      tab.textContent = file.path;
      tab.addEventListener("click", () => {
        activePath = file.path;
        renderViewers();
      });
      return tab;
    }),
  );

  viewersBody.replaceChildren();
  const file = viewed.find((candidate) => candidate.path === activePath);
  if (file === undefined) {
    return;
  }
  const viewer = document.createElement("article");
  viewer.className = "viewer";
  const head = document.createElement("div");
  head.className = "viewer-head";
  const name = document.createElement("span");
  name.className = "viewer-name";
  name.textContent = file.path;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.addEventListener("click", () => closeFile(file.path));
  head.append(name);
  if (isMarkdown(file.path)) {
    head.append(rendererToggle(file));
  }
  head.append(close);
  const text = fileBody(file);
  const foot = document.createElement("div");
  foot.className = "viewer-foot";
  renderFoot(file, foot);
  viewer.append(head, text, foot);
  viewersBody.append(viewer);
}

// The controls under the text: the error, and Load more (or Loading…). Only this part is redrawn while a block loads.
function renderFoot(file: Viewed, foot: HTMLDivElement): void {
  foot.replaceChildren();
  if (file.error !== null) {
    const error = document.createElement("p");
    error.className = "error";
    error.textContent = file.error;
    foot.append(error);
  }
  // A rendered file loads its blocks by itself, so Load more is only offered to retry a block that failed.
  if (file.more && (!file.rendered || file.error !== null)) {
    const more = document.createElement("button");
    more.type = "button";
    more.className = "viewer-more";
    more.textContent = file.loading ? "Loading…" : "Load more";
    more.disabled = file.loading;
    more.addEventListener("click", () => {
      void loadBlock(file.path);
    });
    foot.append(more);
  }
}

// Redraws the foot of a file, if its tab is the one shown.
function refreshFoot(file: Viewed): void {
  if (file.path !== activePath) {
    return;
  }
  const foot = viewersBody.querySelector<HTMLDivElement>(".viewer-foot");
  if (foot !== null) {
    renderFoot(file, foot);
  }
}

// Adds a block's lines to a file. When its tab is the one shown, they are appended to the text already there.
function addLines(file: Viewed, lines: string[]): void {
  const text = (file.lines.length > 0 ? "\n" : "") + lines.join("\n");
  file.lines.push(...lines);
  if (file.path === activePath) {
    viewersBody.querySelector("pre")?.append(document.createTextNode(text));
  }
}

// Fetches the next block of a file that is still open. A response for a file that was closed meanwhile is dropped.
async function loadBlock(path: string): Promise<void> {
  const file = viewed.find((candidate) => candidate.path === path);
  if (file === undefined || file.loading) {
    return;
  }
  file.loading = true;
  file.error = null;
  refreshFoot(file);
  try {
    const data = await postJson<{ lines: string[]; next: number; more: boolean }>("/api/file", {
      path,
      offset: file.next,
    });
    addLines(file, data.lines);
    file.next = data.next;
    file.more = data.more;
  } catch (err) {
    file.error = errorMessage(err);
  } finally {
    file.loading = false;
    refreshFoot(file);
  }
  // A rendered file waits for every block, so it is rendered from its whole text. A failed block stops this, and Load more tries it again.
  if (file.rendered && file.more && file.error === null) {
    void loadBlock(path);
  } else if (file.rendered && file.path === activePath) {
    renderViewers();
  }
}

// The file's text: the raw lines, or the markdown rendered from the whole file once every block has loaded.
function fileBody(file: Viewed): HTMLElement {
  if (!file.rendered) {
    const pre = document.createElement("pre");
    // The text is set as plain text, so nothing in it is read as HTML.
    pre.textContent = file.lines.join("\n");
    return pre;
  }
  const rendered = document.createElement("div");
  rendered.className = "markdown";
  if (file.loading) {
    rendered.textContent = "Loading…";
  } else if (file.more) {
    rendered.textContent = "The rest of the file has not loaded.";
  } else {
    rendered.innerHTML = renderMarkdown(file.lines.join("\n"));
  }
  return rendered;
}

// Switches a file between its rendered markdown and its raw text. Showing it rendered loads the blocks it still lacks.
function rendererToggle(file: Viewed): HTMLButtonElement {
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.textContent = file.rendered ? "Raw" : "Rendered";
  toggle.addEventListener("click", () => {
    file.rendered = !file.rendered;
    if (file.rendered && file.more && !file.loading && file.error === null) {
      void loadBlock(file.path);
    }
    renderViewers();
  });
  return toggle;
}

// Opens a file as a tab and makes it the one shown. Opening a file that is already open only shows its tab.
function openFile(path: string): void {
  if (!viewed.some((file) => file.path === path)) {
    viewed.push({ path, lines: [], next: 0, more: false, loading: false, error: null, rendered: isMarkdown(path) });
    void loadBlock(path);
  }
  activePath = path;
  renderViewers();
}

// Closes one file. When it was the one shown, the file opened last takes its place.
function closeFile(path: string): void {
  const index = viewed.findIndex((file) => file.path === path);
  if (index === -1) {
    return;
  }
  viewed.splice(index, 1);
  if (activePath === path) {
    activePath = viewed.length > 0 ? viewed[viewed.length - 1].path : null;
  }
  renderViewers();
}

viewersCloseAll.addEventListener("click", () => {
  viewed.length = 0;
  activePath = null;
  renderViewers();
});

