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
  const restrict = document.getElementById("pe-restrict") as HTMLInputElement;
  const list = document.getElementById("pe-tools") as HTMLUListElement;
  const save = document.getElementById("pe-save") as HTMLButtonElement;

  const checked = (): string[] =>
    Array.from(
      list.querySelectorAll<HTMLInputElement>("input:checked"),
      (el) => el.value,
    );

  function refresh(): void {
    list.hidden = !restrict.checked;
    // A restriction must allow at least one tool.
    save.disabled = restrict.checked && checked().length === 0;
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
  restrict.addEventListener("change", refresh);
  list.addEventListener("change", refresh);
  save.addEventListener("click", () => {
    if (!select.value) return;
    actions.saveWhitelist(
      select.value,
      restrict.checked ? checked() : undefined,
    );
  });

  return {
    showWhitelist(name, text) {
      if (name !== select.value) return;
      const allowed = parseWhitelist(text);
      restrict.checked = allowed !== undefined;
      list.textContent = "";
      for (const tool of actions.toolNames()) {
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.value = tool;
        checkbox.checked = allowed?.includes(tool) ?? false;
        const label = document.createElement("label");
        label.append(checkbox, document.createTextNode(tool));
        list.appendChild(document.createElement("li")).appendChild(label);
      }
      refresh();
    },
  };
}
