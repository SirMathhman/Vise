// The page's body in two columns: the tree and the file on the left, the chat on the right. While a file is
// open the window shows both at once; on a narrow window the columns stack, with the tree above the chat.
// The chat's panels form one group, capped in height, so a long panel cannot push the transcript and the
// composer off the window.
export function columns(
  doc: Document,
  side: HTMLElement[],
  panels: HTMLElement[],
  rest: HTMLElement[],
): HTMLElement {
  const sideColumn = doc.createElement("div");
  sideColumn.className = "side";
  sideColumn.append(...side);
  const panelGroup = doc.createElement("div");
  panelGroup.className = "chat-panels";
  panelGroup.append(...panels);
  const chatColumn = doc.createElement("div");
  chatColumn.className = "chat";
  chatColumn.append(panelGroup, ...rest);
  const workspace = doc.createElement("div");
  workspace.className = "workspace";
  workspace.append(sideColumn, chatColumn);
  return workspace;
}
