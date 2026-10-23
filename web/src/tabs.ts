// The tabs of the chat page: the open chats and the open files share one row above the chat. Each tab is a name and a
// close button. Each kind keeps its own shown item, so the shown chat and the shown file are both marked.

// Adds a tab to a group of the row. Choosing its name calls onSelect, and its close button calls onClose.
function createTab(group: HTMLElement, label: string, onSelect: () => void, onClose: () => void): HTMLDivElement {
  const tab = document.createElement("div");
  tab.className = "tab-wrap";
  const name = document.createElement("button");
  name.type = "button";
  name.className = "tab";
  name.textContent = label;
  name.addEventListener("click", onSelect);
  const close = document.createElement("button");
  close.type = "button";
  close.className = "tab-close";
  close.textContent = "×";
  close.title = "Close";
  close.addEventListener("click", onClose);
  tab.append(name, close);
  group.append(tab);
  return tab;
}

// Marks a tab as the shown one of its kind.
function setTabActive(tab: HTMLDivElement, shown: boolean): void {
  tab.classList.toggle("active", shown);
}
