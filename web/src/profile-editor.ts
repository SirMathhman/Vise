import { appendToolItem } from "./panels.ts";

export interface ProfileEditorActions {
  /** Ask the server for a profile's whitelist (`/profile <name> tools`). */
  loadWhitelist(name: string): void;
  /** Save a whitelist; `undefined` lifts the restriction (all tools). */
  saveWhitelist(name: string, tools: string[] | undefined): void;
  /** Names of the tools the whitelist can be chosen from. */
  toolNames(): string[];
  /** Names of the profiles that can have a whitelist. */
  profileNames(): string[];
  /** The profile currently active, preselected when the panel opens. */
  activeProfile(): string;
}

export interface ProfileEditor {
  /** Show the server's answer (`profile 'x' tools: a, b` or `... all`). */
  showWhitelist(name: string, text: string): void;
}

/** The `a, b` or `all` part of a `profile 'x' tools: …` reply. */
function parseWhitelist(text: string): string[] | undefined {
  const value = text.slice(text.indexOf("tools:") + "tools:".length).trim();
  if (value === "all") return undefined;
  if (value === "(none)") return [];
  return value.split(",").map((t) => t.trim());
}

/**
 * The profiles panel: pick a profile, choose which tools it may use, and
 * save. Profiles are edited here rather than in the header selects because
 * they will grow more settings than a single dropdown can hold.
 */
export function createProfileEditor(
  actions: ProfileEditorActions,
): ProfileEditor {
  const button = document.getElementById("profiles-btn") as HTMLButtonElement;
  const panel = document.getElementById("profiles-panel") as HTMLElement;
  const select = document.getElementById("pe-profile") as HTMLSelectElement;
  const list = document.getElementById("pe-tools") as HTMLUListElement;
  const save = document.getElementById("pe-save") as HTMLButtonElement;

  const checked = (): string[] =>
    Array.from(
      list.querySelectorAll<HTMLInputElement>("input:checked"),
      (el) => el.value,
    );

  // A profile must allow at least one tool.
  function refresh(): void {
    save.disabled = checked().length === 0;
  }

  function loadSelected(): void {
    if (select.value) actions.loadWhitelist(select.value);
  }

  button.addEventListener("click", () => {
    panel.classList.toggle("hidden");
    if (panel.classList.contains("hidden")) return;
    const active = actions.activeProfile();
    select.textContent = "";
    const names = actions.profileNames();
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.appendChild(option);
    }
    select.selectedIndex = Math.max(0, names.indexOf(active));
    loadSelected();
  });
  select.addEventListener("change", loadSelected);
  list.addEventListener("change", (event) => {
    const box = event.target;
    if (box instanceof HTMLInputElement) {
      box.closest("li")?.classList.toggle("disabled", !box.checked);
    }
    refresh();
  });
  save.addEventListener("click", () => {
    if (!select.value) return;
    // Every tool ticked means no restriction.
    const tools = checked();
    const all = tools.length === actions.toolNames().length;
    actions.saveWhitelist(select.value, all ? undefined : tools);
  });

  return {
    showWhitelist(name, text) {
      if (name !== select.value) return;
      const allowed = parseWhitelist(text);
      list.textContent = "";
      for (const tool of actions.toolNames()) {
        appendToolItem(list, tool, allowed?.includes(tool) ?? true);
      }
      refresh();
    },
  };
}
