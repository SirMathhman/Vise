import type { TreeEntry } from "../../../protocol/protocol.ts";
import { panelBox } from "../mcp-view.ts";

// The file tree the page shows: each folder opens and closes in place, and a click on a file opens it in the
// viewer. A folder's entries are read from the server when it is first opened (see main.ts), so only the
// folders the user opens are sent.

export interface TreeActions {
  toggleFolder(path: string, open: boolean): void;
  openFile(path: string): void;
}

// What the tree shows: the entries read so far, by folder path, and the folders that are open.
export interface TreeShown {
  trees: Record<string, TreeEntry[]>;
  expanded: string[];
}

// The panel that holds the tree. Rebuilt only when what it shows changes.
export interface TreeSection {
  element: HTMLElement;
  update(trees: Record<string, TreeEntry[]>, expanded: string[]): void;
}

export function createTreeSection(doc: Document, actions: TreeActions): TreeSection {
  const box = panelBox(doc);
  let key = "";
  return {
    element: box.element,
    update(trees, expanded) {
      const next = JSON.stringify([trees, expanded]);
      if (next === key) return;
      key = next;
      box.show("Files", trees[""]?.length ?? 0, [treeList(doc, "", { trees, expanded }, actions)]);
    },
  };
}

// The list of one folder's entries. A folder that is open but not read yet says so.
export function treeList(doc: Document, folder: string, shown: TreeShown, actions: TreeActions): HTMLElement {
  const list = doc.createElement("ul");
  list.className = "tree";
  const entries = shown.trees[folder];
  if (entries === undefined) {
    const loading = doc.createElement("li");
    loading.className = "hint";
    loading.textContent = "loading…";
    list.append(loading);
    return list;
  }
  for (const entry of entries) {
    list.append(treeItem(doc, entry, shown, actions));
  }
  return list;
}

// One entry: a file as its name, a folder as a button that opens it, with its entries under it when open.
function treeItem(doc: Document, entry: TreeEntry, shown: TreeShown, actions: TreeActions): HTMLElement {
  const item = doc.createElement("li");
  if (!entry.directory) {
    const file = doc.createElement("button");
    file.type = "button";
    file.className = "folder-toggle";
    file.textContent = entry.name;
    file.addEventListener("click", () => actions.openFile(entry.path));
    item.append(file);
    return item;
  }
  const open = shown.expanded.includes(entry.path);
  const toggle = doc.createElement("button");
  toggle.type = "button";
  toggle.className = "folder-toggle";
  toggle.textContent = `${open ? "▾" : "▸"} ${entry.name}`;
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => actions.toggleFolder(entry.path, !open));
  item.append(toggle);
  if (open) item.append(treeList(doc, entry.path, shown, actions));
  return item;
}
