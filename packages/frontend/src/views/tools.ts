import { ToolsResponseSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const toolsStatus = requireElement("tools-status") as HTMLParagraphElement;
const toolsBody = requireElement("tools-body") as HTMLTableSectionElement;

/**
 * Loads the tools the model may call, and shows each one's name and description.
 */
export async function loadTools(): Promise<void> {
  const result = await apiJson("/api/tools", ToolsResponseSchema);
  if (!result.ok) {
    toolsStatus.textContent = `Unavailable: ${result.error}`;
    return;
  }
  toolsBody.replaceChildren(
    ...result.value.tools.map((tool) => {
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = tool.name;
      const description = document.createElement("td");
      description.textContent = tool.description;
      row.append(name, description);
      return row;
    }),
  );
  toolsStatus.textContent = `${String(result.value.tools.length)} tools`;
}
