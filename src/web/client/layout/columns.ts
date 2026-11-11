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
  return block(doc, "workspace", [
    block(doc, "tree-column", [parts.tree]),
    block(doc, "file-column", [parts.file]),
    chat,
  ]);
}

// An element of the given class, holding the given children.
function block(doc: Document, className: string, children: HTMLElement[]): HTMLElement {
  const node = doc.createElement("div");
  node.className = className;
  node.append(...children);
  return node;
}
