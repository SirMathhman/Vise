import { fetchEvalFunctions, fetchTools } from "./api.js";

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
    toolsList.hidden = false;
    if (!toolsList.childElementCount) {
      try {
        const tools = await fetchTools();
        const evalFunctions = await fetchEvalFunctions();
        for (const tool of tools) {
          toolsList.appendChild(createToolItem(tool));
        }
        toolsList.appendChild(createEvalFunctionsSection(evalFunctions));
        toolsCount.textContent = String(tools.length);
        toolsCount.hidden = tools.length === 0;
      } catch {
        // Leave the list empty; the badge stays hidden. The user can retry
        // by closing and reopening.
      }
    }
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

/**
 * Builds a single tool list item from a tool's display metadata (icon, label,
 * description). Kept separate from openToolsDropdown so the list-building
 * logic is testable and reusable.
 * @param {{name: string, label: string, icon: string, description: string}} tool
 * @returns {HTMLLIElement}
 */
function createToolItem(tool) {
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
  return li;
}

/**
 * Builds the "eval functions" section of the Tools dropdown: a heading plus a
 * list of every function that can be executed inside an eval expression.
 * Built-ins and user-defined functions (from create_function) are shown
 * together, each with its name and a short description.
 * @param {Array<{name: string, description: string, builtin: boolean}>} functions
 * @returns {HTMLLIElement}
 */
function createEvalFunctionsSection(functions) {
  const section = document.createElement("li");
  section.className = "chat-tools-eval-section";

  const heading = document.createElement("div");
  heading.className = "chat-tools-eval-heading";
  heading.textContent = "eval functions";
  section.appendChild(heading);

  for (const fn of functions) {
    const item = document.createElement("div");
    item.className = "chat-tools-eval-item";

    const label = document.createElement("span");
    label.className = "chat-tools-eval-item-label";
    label.textContent = fn.name;
    label.title = fn.builtin
      ? `${fn.name} — built-in`
      : `${fn.name} — defined via create_function`;
    item.appendChild(label);

    const desc = document.createElement("span");
    desc.className = "chat-tools-eval-item-desc";
    desc.textContent = fn.description;
    item.appendChild(desc);

    section.appendChild(item);
  }
  return section;
}
