import type { ToolSummary } from "common";
import { ToolsResponseSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const toolsStatus = requireElement("tools-status") as HTMLParagraphElement;
const toolsBody = requireElement("tools-body") as HTMLTableSectionElement;
const toolsPrev = requireElement("tools-prev") as HTMLButtonElement;
const toolsNext = requireElement("tools-next") as HTMLButtonElement;
const toolsPageLabel = requireElement("tools-page");

// The table shows a fixed number of rows per page, so the whole panel fits the window.
const TOOLS_PAGE_SIZE = 4;

let tools: ToolSummary[] = [];
let toolsPage = 0;

function toolRow(tool: ToolSummary): HTMLTableRowElement {
  const row = document.createElement("tr");
  const name = document.createElement("td");
  name.textContent = tool.name;
  const description = document.createElement("td");
  description.textContent = tool.description;
  row.append(name, description);
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
  toolsStatus.textContent = `${String(tools.length)} tools`;
}

/**
 * Loads the tools the model may call, and shows each one's name and description, a page at a time.
 */
export async function loadTools(): Promise<void> {
  const result = await apiJson("/api/tools", ToolsResponseSchema);
  if (!result.ok) {
    toolsStatus.textContent = `Unavailable: ${result.error}`;
    return;
  }
  tools = result.value.tools;
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
