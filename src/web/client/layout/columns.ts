import { separators } from "./separators.ts";

// The page's body in three columns: the Files tree, the file, and the chat. While a file is open on a wide
// window the three show side by side; on a narrower window the columns stack, tree first. The chat's panels
// form one group, capped in height, so a long panel cannot push the transcript and the composer off the window.
export interface ColumnParts {
  tree: HTMLElement;
  file: HTMLElement;
  panels: HTMLElement[];
  rest: HTMLElement[];
}

export function columns(doc: Document, parts: ColumnParts): HTMLElement {
  const panelGroup = block(doc, "chat-panels", parts.panels);
  const chat = block(doc, "chat", [panelGroup, ...parts.rest]);
  const workspace = block(doc, "workspace", []);
  const [treeHandle, chatHandle] = separators(doc, workspace);
  workspace.append(
    block(doc, "tree-column", [parts.tree]),
    treeHandle,
    block(doc, "file-column", [parts.file]),
    chatHandle,
    chat,
  );
  return workspace;
}

// An element of the given class, holding the given children.
function block(doc: Document, className: string, children: HTMLElement[]): HTMLElement {
  const node = doc.createElement("div");
  node.className = className;
  node.append(...children);
  return node;
}

// Puts the page into or out of the three columns, and returns whether they are shown. The chat's panels (each a
// details element) close when the columns first appear, so the transcript keeps the room; the user can open them.
export function applySplit(root: HTMLElement, panels: HTMLElement[], split: boolean, wasSplit: boolean): boolean {
  if (split && !wasSplit) {
    for (const panel of panels) (panel as HTMLDetailsElement).open = false;
  }
  root.classList.toggle("split-view", split);
  return split;
}
