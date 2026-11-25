import type { ProfileTools, ToolSettings, ToolSummary } from "common";
import {
  NotesResponseSchema,
  OkResponseSchema,
  PROFILE_CATEGORY,
  ProfileToolListsResponseSchema,
  ProfileToolsSchema,
  ToolSettingsSchema,
  ToolsResponseSchema,
} from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const toolsStatus = requireElement("tools-status") as HTMLParagraphElement;
const toolsBody = requireElement("tools-body") as HTMLTableSectionElement;
const toolsPrev = requireElement("tools-prev") as HTMLButtonElement;
const toolsNext = requireElement("tools-next") as HTMLButtonElement;
const toolsPageLabel = requireElement("tools-page");
const toolsScope = requireElement("tools-scope") as HTMLSelectElement;
const toolsClear = requireElement("tools-clear") as HTMLButtonElement;

const GLOBAL = "global";
const SETTINGS_PATH = "/api/tool-settings";
const PROFILES_PATH = "/api/tool-settings/profiles";

// The table shows a fixed number of rows per page, so the whole panel fits the window.
const TOOLS_PAGE_SIZE = 4;

let tools: ToolSummary[] = [];
// The tools turned off for everyone.
let disabled = new Set<string>();
// Each profile's whitelist. A profile with no entry has none.
let lists: Record<string, string[]> = {};
let toolsPage = 0;

// Saves run one after another, so each starts from the result of the one before.
let saving: Promise<void> = Promise.resolve();

// The tools that are on for the chosen scope: a profile's whitelist, or else the tools not turned off.
function enabledNames(): Set<string> {
  const scope = toolsScope.value;
  const listed =
    scope !== GLOBAL && Object.hasOwn(lists, scope) ? lists[scope] : undefined;
  if (listed !== undefined) {
    return new Set(listed);
  }
  return new Set(
    tools.map((tool) => tool.name).filter((name) => !disabled.has(name)),
  );
}

// Turns one tool on or off for the chosen scope. A profile with no whitelist gets one, made from the
// tools that are on now.
async function setState(name: string, state: "on" | "off"): Promise<void> {
  const scope = toolsScope.value;
  if (scope === GLOBAL) {
    const next = new Set(disabled);
    if (state === "on") {
      next.delete(name);
    } else {
      next.add(name);
    }
    const body: ToolSettings = { disabled: [...next] };
    const result = await apiJson(SETTINGS_PATH, ToolSettingsSchema, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!result.ok) {
      toolsStatus.textContent = `Could not save: ${result.error}`;
      return;
    }
    disabled = new Set(result.value.disabled);
    return;
  }
  const next = enabledNames();
  if (state === "on") {
    next.add(name);
  } else {
    next.delete(name);
  }
  const body: ProfileTools = { tools: [...next] };
  const result = await apiJson(
    `${PROFILES_PATH}/${encodeURIComponent(scope)}`,
    ProfileToolsSchema,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!result.ok) {
    toolsStatus.textContent = `Could not save: ${result.error}`;
    return;
  }
  lists = { ...lists, [scope]: result.value.tools };
}

function queueChange(name: string, state: "on" | "off"): void {
  saving = saving.then(async () => {
    await setState(name, state);
    renderPage();
  });
}

// Removes the chosen profile's whitelist, so it goes back to the tools that are on for everyone.
async function clearList(): Promise<void> {
  const scope = toolsScope.value;
  const result = await apiJson(
    `${PROFILES_PATH}/${encodeURIComponent(scope)}`,
    OkResponseSchema,
    {
      method: "DELETE",
    },
  );
  if (!result.ok) {
    toolsStatus.textContent = `Could not clear: ${result.error}`;
    return;
  }
  lists = Object.fromEntries(
    Object.entries(lists).filter(([id]) => id !== scope),
  );
  renderPage();
}

function toolRow(tool: ToolSummary, enabled: Set<string>): HTMLTableRowElement {
  const row = document.createElement("tr");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = enabled.has(tool.name);
  toggle.setAttribute("aria-label", `Allow ${tool.name}`);
  toggle.addEventListener("change", () => {
    queueChange(tool.name, toggle.checked ? "on" : "off");
  });
  const on = document.createElement("td");
  on.append(toggle);
  const name = document.createElement("td");
  name.textContent = tool.name;
  const description = document.createElement("td");
  description.textContent = tool.description;
  row.append(on, name, description);
  return row;
}

function renderPage(): void {
  const scope = toolsScope.value;
  const enabled = enabledNames();
  const pageCount = Math.max(1, Math.ceil(tools.length / TOOLS_PAGE_SIZE));
  toolsPage = Math.min(toolsPage, pageCount - 1);
  const start = toolsPage * TOOLS_PAGE_SIZE;
  toolsBody.replaceChildren(
    ...tools
      .slice(start, start + TOOLS_PAGE_SIZE)
      .map((tool) => toolRow(tool, enabled)),
  );
  toolsPageLabel.textContent = `Page ${String(toolsPage + 1)} of ${String(pageCount)}`;
  toolsPrev.disabled = toolsPage === 0;
  toolsNext.disabled = toolsPage >= pageCount - 1;
  toolsClear.disabled = scope === GLOBAL || !Object.hasOwn(lists, scope);
  const who = scope === GLOBAL ? "on" : "allowed for this profile";
  toolsStatus.textContent = `${String(tools.length)} tools, ${String(enabled.size)} ${who}`;
}

/**
 * Loads the tools, the switches, the profile whitelists, and the profiles to choose from.
 */
export async function loadTools(): Promise<void> {
  const list = await apiJson("/api/tools", ToolsResponseSchema);
  const settings = await apiJson(SETTINGS_PATH, ToolSettingsSchema);
  const profileLists = await apiJson(
    PROFILES_PATH,
    ProfileToolListsResponseSchema,
  );
  const notes = await apiJson("/api/notes", NotesResponseSchema);
  if (!list.ok || !settings.ok || !profileLists.ok) {
    const failure = !list.ok
      ? list.error
      : !settings.ok
        ? settings.error
        : profileLists.ok
          ? ""
          : profileLists.error;
    toolsStatus.textContent = `Unavailable: ${failure}`;
    return;
  }
  tools = list.value.tools;
  disabled = new Set(settings.value.disabled);
  lists = profileLists.value.profiles;
  const profiles = notes.ok
    ? notes.value.notes.filter((note) => note.category === PROFILE_CATEGORY)
    : [];
  const previous = toolsScope.value;
  toolsScope.replaceChildren(
    new Option("Global", GLOBAL),
    ...profiles.map((p) => new Option(p.name, p.id)),
  );
  const scopes = [GLOBAL, ...profiles.map((p) => p.id)];
  toolsScope.value = scopes.includes(previous) ? previous : GLOBAL;
  renderPage();
}

/**
 * Connects the scope picker, the clear button, and the table's pager.
 */
export function initTools(): void {
  toolsPrev.addEventListener("click", () => {
    toolsPage -= 1;
    renderPage();
  });
  toolsNext.addEventListener("click", () => {
    toolsPage += 1;
    renderPage();
  });
  toolsScope.addEventListener("change", () => {
    toolsPage = 0;
    renderPage();
  });
  toolsScope.addEventListener("focus", () => void loadTools());
  toolsClear.addEventListener("click", () => {
    saving = saving.then(clearList);
  });
}
