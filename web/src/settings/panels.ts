import { parseSessionList, renderSessionList, type SavedSession } from "./sessions-list.ts";

export interface PanelActions {
  resumeSession(name: string): void;
  deleteSession(name: string): void;
}

export interface Panels {
  addProfilePlaceholder(): void;
  populateProfileSelect(text: string): void;
  populateReasoningSelect(text: string): void;
  populateSessionsPanel(text: string): void;
  populateToolsPanel(text: string): void;
  removeProfilePlaceholder(): void;
  /** The profile files changed: the header choices become `default` and these, keeping the active one. */
  syncProfileOptions(names: string[]): void;
  /** The saved sessions, newest first. */
  sessions(): SavedSession[];
  toolNames(): string[];
  /** The category a tool was listed under (set by the last tools listing). */
  toolCategory(name: string): string | undefined;
}

export function createPanels(actions: PanelActions): Panels {
  const profileSelect = document.getElementById("profile") as HTMLSelectElement;
  const reasoningSelect = document.getElementById(
    "reasoning",
  ) as HTMLSelectElement;
  const toolsList = document.getElementById("tools-list") as HTMLUListElement;
  const sessionsList = document.getElementById(
    "sessions-list",
  ) as HTMLUListElement;
  const sessionsFilter = document.getElementById(
    "sessions-filter",
  ) as HTMLInputElement;
  let saved: SavedSession[] = [];
  const drawSessions = (): void =>
    renderSessionList(sessionsList, saved, sessionsFilter.value, {
      resume: actions.resumeSession,
      remove: actions.deleteSession,
    });
  sessionsFilter.addEventListener("input", drawSessions);

  const categories = new Map<string, string>();
  /** The tools of the last listing, in order: the data source for `toolNames()` (never the DOM). */
  const names: string[] = [];

  return {
    toolCategory: (name) => categories.get(name),
    addProfilePlaceholder: () => addProfilePlaceholder(profileSelect),
    populateProfileSelect: (text) => populateProfileSelect(profileSelect, text),
    populateReasoningSelect: (text) =>
      populateReasoningSelect(reasoningSelect, text),
    populateSessionsPanel(text) {
      saved = parseSessionList(text);
      drawSessions();
    },
    populateToolsPanel: (text) =>
      populateToolsPanel(toolsList, text, categories, names),
    removeProfilePlaceholder: () => removeProfilePlaceholder(profileSelect),
    syncProfileOptions: (names) => syncProfileOptions(profileSelect, names),
    sessions: () => [...saved],
    toolNames: () => [...names],
  };
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
export function syncCategoryToggles(list: HTMLUListElement): void {
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
  names: string[],
): void {
  list.textContent = "";
  categories.clear();
  names.length = 0;
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
    names.push(name);
    if (category !== undefined) categories.set(name, category);
    appendToolItem(list, name, enabled);
  }
  if (count === 0) {
    const empty = list.appendChild(document.createElement("li"));
    empty.className = "list-empty";
    empty.textContent = "No tools available.";
  }
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

/** Rebuild the profile choices from the files (plus the built-in "default"), keeping the selection. */
function syncProfileOptions(select: HTMLSelectElement, names: string[]): void {
  const current = select.value;
  const placeholder = select.querySelector('option[value=""]');
  select.textContent = "";
  if (placeholder) select.appendChild(placeholder);
  for (const name of ["default", ...names.filter((n) => n !== "default")]) {
    select.appendChild(new Option(name, name));
  }
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  else {
    addProfilePlaceholder(select);
    select.value = "";
  }
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
