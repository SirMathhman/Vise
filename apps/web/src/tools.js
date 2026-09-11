import { fetchTools } from "./api.js";

/**
 * Wires up the "Tools" dropdown in the chat header: a read-only list of the
 * tools the model can call, populated lazily from the backend's TOOLS
 * registry (the single source of truth) so the UI never hardcodes a second
 * copy of the tool list. Owns its own DOM, fetch, and open/close state; reads
 * no conversation state.
 * @param {HTMLElement} appEl - The app root element.
 */
export function setupTools(appEl) {
  const toolsBtn = appEl.querySelector("#chat-tools-btn");
  const toolsList = appEl.querySelector("#chat-tools-list");
  const toolsCount = appEl.querySelector("#chat-tools-count");

  const openToolsDropdown = async () => {
    toolsBtn.setAttribute("aria-expanded", "true");
    if (!toolsList.childElementCount) {
      try {
        const tools = await fetchTools();
        for (const tool of tools) {
          const li = document.createElement("li");
          li.className = "chat-tools-item";
          li.title = tool.description;

          const icon = document.createElement("span");
          icon.className = "chat-tools-item-icon";
          icon.textContent = tool.icon ?? "🔧";
          li.appendChild(icon);

          const body = document.createElement("span");
          body.className = "chat-tools-item-body";

          const label = document.createElement("span");
          label.className = "chat-tools-item-label";
          label.textContent = tool.label ?? tool.name;
          body.appendChild(label);

          const desc = document.createElement("span");
          desc.className = "chat-tools-item-desc";
          desc.textContent = tool.description;
          body.appendChild(desc);

          li.appendChild(body);

          toolsList.appendChild(li);
        }
        toolsCount.textContent = String(tools.length);
        toolsCount.hidden = tools.length === 0;
      } catch {
        // Leave the list empty; the badge stays hidden. The user can retry
        // by closing and reopening.
      }
    }
    toolsList.hidden = false;
  };

  const closeToolsDropdown = () => {
    toolsList.hidden = true;
    toolsBtn.setAttribute("aria-expanded", "false");
  };

  toolsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (toolsList.hidden) openToolsDropdown();
    else closeToolsDropdown();
  });

  // Close on outside click or Escape.
  document.addEventListener("click", (e) => {
    if (toolsList.hidden) return;
    if (e.target.closest(".chat-tools-dropdown")) return;
    closeToolsDropdown();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !toolsList.hidden) closeToolsDropdown();
  });
}
