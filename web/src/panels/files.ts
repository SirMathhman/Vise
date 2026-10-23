// The Files panel: the working directory's tree, and the refresh button.

// The Files panel: the working directory's tree. A folder's entries are fetched when it is first opened, a page at a
// time, so no folder is read in full and no part of the tree is fetched until it is opened.
interface TreeEntry {
  name: string;
  dir: boolean;
}

// The last entry a page holds. The next page starts after it.
interface TreeCursor {
  name: string;
  dir: boolean;
}

interface FolderPage {
  dir: string;
  name: string;
  entries: TreeEntry[];
  next: TreeCursor | null;
  more: boolean;
}

const filesTree = document.getElementById("files-tree") as HTMLDivElement;
const filesRefresh = document.getElementById("files-refresh") as HTMLButtonElement;

// One entry as a row. A folder is a closed section that fetches its entries when first opened. A file is a button that
// opens it.
function treeItem(entry: TreeEntry, dir: string): HTMLLIElement {
  const item = document.createElement("li");
  const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
  if (entry.dir) {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${entry.name}/`;
    const body = document.createElement("div");
    // A folder is fetched when it is first opened. A failed fetch is tried again on the next opening.
    let fetched = false;
    let fetching = false;
    details.addEventListener("toggle", async () => {
      if (details.open && !fetched && !fetching) {
        fetching = true;
        fetched = (await loadFolderPage(path, body, null)) !== null;
        fetching = false;
      }
    });
    details.append(summary, body);
    item.append(details);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "file-link";
    button.textContent = entry.name;
    button.addEventListener("click", () => {
      openFile(path);
    });
    item.append(button);
  }
  return item;
}

// Adds one page of a folder's entries to its body, with Load more when more follow. A failed request shows its reason
// and keeps Load more, so the same page can be asked for again. The list and the controls are found as direct children,
// so a folder nested inside never picks up this one's controls.
// The folders whose page is being fetched. A second request for the same folder waits for the first, so a double click
// on Load more cannot append the same entries twice.
const fetchingFolders = new WeakSet<HTMLElement>();

async function loadFolderPage(dir: string, body: HTMLElement, after: TreeCursor | null): Promise<FolderPage | null> {
  if (fetchingFolders.has(body)) {
    return null;
  }
  fetchingFolders.add(body);
  body.querySelector(":scope > .tree-error")?.remove();
  let list = body.querySelector<HTMLUListElement>(":scope > ul");
  if (list === null) {
    list = document.createElement("ul");
    body.append(list);
  }
  try {
    const page = await postJson<FolderPage>("/api/files", { dir, after });
    body.querySelector(":scope > .tree-more")?.remove();
    list.append(...page.entries.map((entry) => treeItem(entry, dir)));
    if (page.more && page.next !== null) {
      const next = page.next;
      const more = document.createElement("button");
      more.type = "button";
      more.className = "tree-more";
      more.textContent = "Load more";
      more.addEventListener("click", () => {
        void loadFolderPage(dir, body, next);
      });
      body.append(more);
    }
    return page;
  } catch (err) {
    const error = document.createElement("p");
    error.className = "error tree-error";
    error.textContent = errorMessage(err);
    body.append(error);
    return null;
  } finally {
    fetchingFolders.delete(body);
  }
}

async function refreshFiles(): Promise<void> {
  filesTree.replaceChildren();
  const page = await loadFolderPage("", filesTree, null);
  if (page !== null) {
    const title = document.createElement("p");
    title.className = "description";
    title.textContent = `${page.name}/`;
    filesTree.prepend(title);
  }
}

filesRefresh.addEventListener("click", () => {
  void refreshFiles();
});

