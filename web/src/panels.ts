export interface PanelActions {
  resumeSession(name: string): void;
  deleteSession(name: string): void;
}

export interface Panels {
  addProfilePlaceholder(): void;
  populateModelSelect(text: string): void;
  populateProfileSelect(text: string): void;
  populateReasoningSelect(text: string): void;
  populateSessionsPanel(text: string): void;
  populateToolsPanel(text: string): void;
  removeProfilePlaceholder(): void;
  sessions(): { id: string; name: string }[];
  toolNames(): string[];
  /** The category a tool was listed under (set by the last tools listing). */
  toolCategory(name: string): string | undefined;
}

export function createPanels(actions: PanelActions): Panels {
  const modelSelect = document.getElementById("model") as HTMLSelectElement;
  const profileSelect = document.getElementById("profile") as HTMLSelectElement;
  const reasoningSelect = document.getElementById(
    "reasoning",
  ) as HTMLSelectElement;
  const toolsList = document.getElementById("tools-list") as HTMLUListElement;
  const sessionsList = document.getElementById(
    "sessions-list",
  ) as HTMLUListElement;

  const categories = new Map<string, string>();

  return {
    toolCategory: (name) => categories.get(name),
    addProfilePlaceholder: () => addProfilePlaceholder(profileSelect),
    populateModelSelect: (text) => populateModelSelect(modelSelect, text),
    populateProfileSelect: (text) => populateProfileSelect(profileSelect, text),
    populateReasoningSelect: (text) =>
      populateReasoningSelect(reasoningSelect, text),
    populateSessionsPanel: (text) =>
      populateSessionsPanel(sessionsList, text, actions),
    populateToolsPanel: (text) =>
      populateToolsPanel(toolsList, text, categories),
    removeProfilePlaceholder: () => removeProfilePlaceholder(profileSelect),
    sessions: () =>
      Array.from(
        sessionsList.querySelectorAll<HTMLElement>(".session-name"),
        (el) => ({ id: el.dataset.id ?? "", name: el.textContent ?? "" }),
      ),
    toolNames: () =>
      Array.from(
        toolsList.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
        (el) => el.value,
      ),
  };
}

function populateModelSelect(
  select: HTMLSelectElement,
  listText: string,
): void {
  select.textContent = "";
  let activeFound = false;
  let count = 0;
  for (const line of listText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no models available") {
      count = -1;
      break;
    }
    count++;
    const option = document.createElement("option");
    if (line[0] === "*") {
      option.value = line
        .slice(1)
        .trim()
        .replace(/ \(active\)$/, "");
      option.textContent = option.value;
      select.appendChild(option);
      select.value = option.value;
      activeFound = true;
    } else {
      option.value = trimmed;
      option.textContent = trimmed;
      select.appendChild(option);
    }
  }
  if (count === 0) appendPlaceholder(select, "no models available");
  else if (!activeFound && count > 0)
    appendPlaceholder(select, "no active model", true);
}

function populateReasoningSelect(
  select: HTMLSelectElement,
  listText: string,
): void {
  select.textContent = "";
  for (const line of listText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no reasoning efforts available") {
      select.value = "";
      break;
    }
    const option = document.createElement("option");
    option.value =
      line[0] === "*"
        ? line
            .slice(1)
            .trim()
            .replace(/ \(active\)$/, "")
        : trimmed;
    option.textContent = option.value;
    select.appendChild(option);
    if (line[0] === "*") select.value = option.value;
  }
}

/**
 * A category heading row inside a tool list. With `toggle`, it carries a
 * checkbox (value = the category name) that enables or disables the group.
 */
export function appendToolCategory(
  list: HTMLUListElement,
  name: string,
  toggle = false,
): void {
  const item = document.createElement("li");
  item.className = "tool-category";
  if (toggle) {
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = name;
    checkbox.title = `Enable or disable every ${name} tool`;
    const label = document.createElement("label");
    label.append(checkbox, document.createTextNode(name));
    item.appendChild(label);
  } else {
    item.textContent = name;
  }
  list.appendChild(item);
}

/** Tick each category checkbox when all its tools are on; leave it mixed when only some are. */
function syncCategoryToggles(list: HTMLUListElement): void {
  for (const head of list.querySelectorAll<HTMLElement>("li.tool-category")) {
    const toggle = head.querySelector<HTMLInputElement>("input");
    if (!toggle) continue;
    const states: boolean[] = [];
    for (let row = head.nextElementSibling; row; row = row.nextElementSibling) {
      if (row.classList.contains("tool-category")) break;
      const box = row.querySelector<HTMLInputElement>("input");
      if (box) states.push(box.checked);
    }
    toggle.checked = states.every(Boolean);
    toggle.indeterminate = toggle.checked ? false : states.some(Boolean);
  }
}

/** One tool as a checkbox row; unchecked rows are dimmed. */
export function appendToolItem(
  list: HTMLUListElement,
  name: string,
  checked: boolean,
): void {
  const item = document.createElement("li");
  if (!checked) item.classList.add("disabled");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.value = name;
  checkbox.checked = checked;
  const label = document.createElement("label");
  label.append(checkbox, document.createTextNode(name));
  item.appendChild(label);
  list.appendChild(item);
}

function populateToolsPanel(
  list: HTMLUListElement,
  listText: string,
  categories: Map<string, string>,
): void {
  list.textContent = "";
  categories.clear();
  let category: string | undefined;
  let count = 0;
  for (const line of listText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no tools available") {
      count = -1;
      break;
    }
    // `[category]` lines head the group of tools that follows.
    const heading = /^\[(.+)\]$/.exec(trimmed);
    if (heading) {
      category = heading[1];
      appendToolCategory(list, category ?? "", true);
      continue;
    }
    count++;
    const enabled = line[0] === "*";
    const raw = enabled ? line.slice(1).trim() : line.trimStart();
    const name = raw.replace(/ \(enabled\)$/, "").replace(/ \(disabled\)$/, "");
    if (category !== undefined) categories.set(name, category);
    appendToolItem(list, name, enabled);
  }
  if (count === 0)
    list.appendChild(document.createElement("li")).textContent =
      "no tools available";
  syncCategoryToggles(list);
}

function populateProfileSelect(
  select: HTMLSelectElement,
  listText: string,
): void {
  select.textContent = "";
  let activeFound = false;
  let count = 0;
  for (const line of listText.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed === "no profiles found") {
      count = -1;
      break;
    }
    count++;
    const option = document.createElement("option");
    option.value =
      line[0] === "*"
        ? line
            .slice(1)
            .trim()
            .replace(/ \(active\)$/, "")
        : trimmed;
    option.textContent = option.value;
    select.appendChild(option);
    if (line[0] === "*") {
      select.value = option.value;
      activeFound = true;
    }
  }
  if (count === 0) appendPlaceholder(select, "no profiles");
  else if (!activeFound && count > 0) addProfilePlaceholder(select);
}

function populateSessionsPanel(
  list: HTMLUListElement,
  listText: string,
  actions: PanelActions,
): void {
  list.textContent = "";
  let count = 0;
  for (const line of listText.split("\n")) {
    // Rows look like `  <name>  (<uuid>)`; the id is what /resume and /delete take.
    const row = /^ {2}(.+?) {2}\(([0-9a-f-]+)\)$/.exec(line);
    if (!row) continue;
    const name = row[1] ?? "";
    const id = row[2] ?? "";
    count++;
    const item = document.createElement("li");
    item.className = "session-row";
    const label = document.createElement("span");
    label.className = "session-name";
    label.textContent = name;
    label.dataset.id = id;
    label.title = id;
    label.addEventListener("click", () => actions.resumeSession(id));
    item.appendChild(label);
    const del = document.createElement("button");
    del.className = "session-delete";
    del.textContent = "×";
    del.title = `delete ${name} (${id})`;
    del.addEventListener("click", () => actions.deleteSession(id));
    item.appendChild(del);
    list.appendChild(item);
  }
  if (count === 0)
    list.appendChild(document.createElement("li")).textContent =
      "no saved sessions";
}

function appendPlaceholder(
  select: HTMLSelectElement,
  text: string,
  before = false,
): void {
  const option = document.createElement("option");
  option.value = "";
  option.textContent = text;
  option.disabled = true;
  if (before) select.insertBefore(option, select.firstChild);
  else select.appendChild(option);
}

function addProfilePlaceholder(select: HTMLSelectElement): void {
  if (select.querySelector('option[value=""]')) return;
  appendPlaceholder(select, "no active profile", true);
}

function removeProfilePlaceholder(select: HTMLSelectElement): void {
  const option = select.querySelector('option[value=""]');
  if (option) select.removeChild(option);
}
