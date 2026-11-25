import type { ToolSettings, ToolSummary } from "common";
import { ToolSettingsSchema, ToolsResponseSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const toolsStatus = requireElement("tools-status") as HTMLParagraphElement;
const toolsBody = requireElement("tools-body") as HTMLTableSectionElement;
const toolsPrev = requireElement("tools-prev") as HTMLButtonElement;
const toolsNext = requireElement("tools-next") as HTMLButtonElement;
const toolsPageLabel = requireElement("tools-page");

const SETTINGS_PATH = "/api/tool-settings";

// The table shows a fixed number of rows per page, so the whole panel fits the window.
const TOOLS_PAGE_SIZE = 4;

let tools: ToolSummary[] = [];
let disabled = new Set<string>();
let toolsPage = 0;

// Saves which tools are on. The page is redrawn from the saved list, so a refused save puts the
// checkbox back.
async function setState(name: string, state: "on" | "off"): Promise<void> {
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
    renderPage();
    return;
  }
  disabled = new Set(result.value.disabled);
  renderPage();
}

function toolRow(tool: ToolSummary): HTMLTableRowElement {
  const row = document.createElement("tr");
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = !disabled.has(tool.name);
  toggle.setAttribute("aria-label", `Turn on ${tool.name}`);
  toggle.addEventListener("change", () => {
    void setState(tool.name, toggle.checked ? "on" : "off");
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
  const pageCount = Math.max(1, Math.ceil(tools.length / TOOLS_PAGE_SIZE));
  toolsPage = Math.min(toolsPage, pageCount - 1);
  const start = toolsPage * TOOLS_PAGE_SIZE;
  toolsBody.replaceChildren(
    ...tools.slice(start, start + TOOLS_PAGE_SIZE).map(toolRow),
  );
  toolsPageLabel.textContent = `Page ${String(toolsPage + 1)} of ${String(pageCount)}`;
  toolsPrev.disabled = toolsPage === 0;
  toolsNext.disabled = toolsPage >= pageCount - 1;
  toolsStatus.textContent = `${String(tools.length)} tools, ${String(tools.length - disabled.size)} on`;
}

/**
 * Loads the tools and which of them are turned on, and shows them a page at a time.
 */
export async function loadTools(): Promise<void> {
  const list = await apiJson("/api/tools", ToolsResponseSchema);
  if (!list.ok) {
    toolsStatus.textContent = `Unavailable: ${list.error}`;
    return;
  }
  const settings = await apiJson(SETTINGS_PATH, ToolSettingsSchema);
  if (!settings.ok) {
    toolsStatus.textContent = `Unavailable: ${settings.error}`;
    return;
  }
  tools = list.value.tools;
  disabled = new Set(settings.value.disabled);
  renderPage();
}

/**
 * Connects the tools table's pager.
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
}
