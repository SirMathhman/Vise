import { llmToolDefinitions, META_TOOL_NAMES } from "../llm/tools.js";
import type { Profile, ProfileStore } from "./profiles.js";

/**
 * Render a profile's allowed-tools checklist into `container`, replacing any
 * previous content. Checking a box calls `onChange` with the full new
 * allowed-tools list; the caller (the Profiles panel) owns persisting it.
 */
export function renderProfileToolList(
  container: HTMLElement,
  profile: Profile,
  onChange: (allowed: string[]) => void
): void {
  container.innerHTML = "";
  let allowed = [...profile.allowedTools];
  const list = document.createElement("ul");
  list.className = "llm-tools-list";
  for (const tool of llmToolDefinitions) {
    const name = tool.function.name;
    if (META_TOOL_NAMES.includes(name)) continue; // infrastructure, not a permission
    const li = document.createElement("li");
    li.className = "llm-tool";
    li.classList.toggle("llm-tool-disabled", !allowed.includes(name));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "llm-tool-toggle";
    cb.value = name;
    cb.checked = allowed.includes(name);
    cb.addEventListener("change", () => {
      allowed = cb.checked
        ? [...allowed, name]
        : allowed.filter((n) => n !== name);
      li.classList.toggle("llm-tool-disabled", !cb.checked);
      onChange(allowed);
    });
    const body = document.createElement("div");
    body.className = "llm-tool-body";
    const codeEl = document.createElement("code");
    codeEl.className = "llm-tool-name";
    codeEl.textContent = name;
    const desc = document.createElement("span");
    desc.className = "llm-tool-desc";
    desc.textContent = tool.function.description;
    // Click the tool name to expand/collapse its description (collapsed by
    // default so the whole list stays compact and the modal never needs an
    // outer scrollbar).
    codeEl.addEventListener("click", () =>
      desc.classList.toggle("llm-tool-desc-expanded")
    );
    body.append(codeEl, desc);
    li.append(cb, body);
    list.append(li);
  }
  container.append(list);
}

/**
 * Render a profile's allowed-subagent-profiles checklist into `container`,
 * replacing any previous content. Checked boxes are the profile ids a
 * subagent spawned under this profile may run under; an empty set means
 * unrestricted (every profile allowed). The profile's own id is always a
 * valid entry — subagents are always allowed to run under their parent's
 * profile. Checking a box calls `onChange` with the full new list of ids;
 * the caller (the Profiles panel) owns persisting it.
 */
export function renderSubagentProfileList(
  container: HTMLElement,
  profiles: ProfileStore,
  profile: Profile,
  onChange: (allowed: string[]) => void
): void {
  container.innerHTML = "";
  let allowed = [...profile.allowedSubagentProfiles];
  const list = document.createElement("ul");
  list.className = "llm-tools-list";
  for (const p of profiles.getProfiles()) {
    const li = document.createElement("li");
    li.className = "llm-tool";
    li.classList.toggle("llm-tool-disabled", !allowed.includes(p.id));
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.className = "llm-tool-toggle";
    cb.value = p.id;
    cb.checked = allowed.includes(p.id);
    cb.addEventListener("change", () => {
      allowed = cb.checked
        ? [...allowed, p.id]
        : allowed.filter((id) => id !== p.id);
      li.classList.toggle("llm-tool-disabled", !cb.checked);
      onChange(allowed);
    });
    const body = document.createElement("div");
    body.className = "llm-tool-body";
    const codeEl = document.createElement("code");
    codeEl.className = "llm-tool-name";
    codeEl.textContent = p.name;
    body.append(codeEl);
    li.append(cb, body);
    list.append(li);
  }
  container.append(list);
}
