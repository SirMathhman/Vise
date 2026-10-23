// The Tools panel: the tools this tab uses, each switched on or off on the server.

interface ToolInfo {
  name: string;
  description: string;
  enabled: boolean;
}

const toolsList = document.getElementById("tools-list") as HTMLUListElement;
const toolsError = document.getElementById("tools-error") as HTMLParagraphElement;

// Lists this tab's tools, or switches one of them, on the server. The panel always shows the server's answer, so it
// stays right when a tool is changed by a typed /enable or /disable.
async function sendTools(change?: { name: string; enabled: boolean }): Promise<ToolInfo[]> {
  const res = await fetch("/api/tools", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ session, ...change }),
  });
  const data = (await res.json().catch(() => ({}))) as { tools?: ToolInfo[]; error?: string };
  if (!res.ok || data.tools === undefined) {
    throw new Error(data.error ?? `HTTP ${res.status}`);
  }
  return data.tools;
}

function renderTools(tools: ToolInfo[]): void {
  toolsList.replaceChildren(
    ...tools.map((tool) => {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.checked = tool.enabled;
      toggle.addEventListener("change", async () => {
        toggle.disabled = true;
        try {
          renderTools(await sendTools({ name: tool.name, enabled: toggle.checked }));
          toolsError.hidden = true;
        } catch (err) {
          showToolsError(err);
          await refreshTools();
        }
      });
      const name = document.createElement("span");
      name.textContent = tool.name;
      label.append(toggle, name);
      const description = document.createElement("div");
      description.className = "description";
      description.innerHTML = renderMarkdown(tool.description);
      item.append(label, description);
      return item;
    }),
  );
}

function showToolsError(err: unknown): void {
  toolsError.textContent = errorMessage(err);
  toolsError.hidden = false;
}

async function refreshTools(): Promise<void> {
  try {
    renderTools(await sendTools());
    toolsError.hidden = true;
  } catch (err) {
    showToolsError(err);
  }
}

