// The page's body in two columns: the tree and the file on the left, the chat on the right. While a file is
// open the window shows both at once; on a narrow window the columns stack, with the tree above the chat.
export function columns(doc: Document, side: HTMLElement[], chat: HTMLElement[]): HTMLElement {
  const sideColumn = doc.createElement("div");
  sideColumn.className = "side";
  sideColumn.append(...side);
  const chatColumn = doc.createElement("div");
  chatColumn.className = "chat";
  chatColumn.append(...chat);
  const workspace = doc.createElement("div");
  workspace.className = "workspace";
  workspace.append(sideColumn, chatColumn);
  return workspace;
}
