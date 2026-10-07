import type { HooksFields } from "./hooks-panel.ts";
import { appendToolCategory, appendToolItem } from "./panels.ts";
import { renderProfileHooks } from "./profile-hooks.ts";

export interface ProfileEditorActions {
  /** Ask the server for the hooks and their profile bindings. */
  loadHooks(): void;
  /** Send a `/hooks bind|unbind ...` line. */
  editHook(line: string): void;
  /** Ask the server for a profile's whitelist (`/profile <name> tools`). */
  loadWhitelist(name: string): void;
  /** Save a whitelist; `undefined` lifts the restriction (all tools). */
  saveWhitelist(name: string, tools: string[] | undefined): void;
  /** Names of the tools the whitelist can be chosen from. */
  toolNames(): string[];
  /** The category a tool belongs to, for grouping the list. */
  toolCategory(name: string): string | undefined;
  /** Names of the profiles that can have a whitelist. */
  profileNames(): string[];
  /** The profile currently active, preselected when the panel opens. */
  activeProfile(): string;
}

export interface ProfileEditor {
  /** Show the hooks with a checkbox for binding each to the selected profile. */
  showHooks(hooks: HooksFields): void;
  /** Reload the profile list and the selected whitelist (the panel just opened). */
  refresh(): void;
  /** Briefly confirm a save (or report why it failed) next to the button. */
  showStatus(text: string, error?: boolean): void;
  /** Show a profile's whitelist; `undefined` means every tool is allowed. */
  showWhitelist(name: string, tools: string[] | undefined): void;
}

/**
 * The profiles panel: pick a profile, choose which tools it may use, and
 * save. Profiles are edited here rather than in the header selects because
 * they will grow more settings than a single dropdown can hold.
 */
export function createProfileEditor(
  actions: ProfileEditorActions,
): ProfileEditor {
  const select = document.getElementById("pe-profile") as HTMLSelectElement;
  const list = document.getElementById("pe-tools") as HTMLUListElement;
  const save = document.getElementById("pe-save") as HTMLButtonElement;
  const status = document.getElementById("pe-status") as HTMLElement;
  const hooksBox = document.getElementById("pe-hooks") as HTMLElement;
  let hooks: HooksFields = {};
  const drawHooks = (): void =>
    renderProfileHooks(hooksBox, hooks, select.value, actions.editHook);
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  let waitingHint: ReturnType<typeof setTimeout> | undefined;

  // `pending` keeps the text up until the reply replaces it; otherwise it
  // clears itself after a few seconds.
  function showStatus(text: string, error = false, pending = false): void {
    clearTimeout(statusTimer);
    if (!pending) clearTimeout(waitingHint);
    status.textContent = text;
    status.classList.toggle("error", error);
    if (text !== "saving…" && !pending) {
      statusTimer = setTimeout(() => (status.textContent = ""), 3000);
    }
  }
  const checkAll = document.getElementById("pe-check-all") as HTMLButtonElement;
  const uncheckAll = document.getElementById(
    "pe-uncheck-all",
  ) as HTMLButtonElement;

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
    drawHooks();
  }

  /** Reload the profile list and the selected whitelist; call when the panel opens. */
  function open(): void {
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
    actions.loadHooks();
  }
  select.addEventListener("change", () => {
    status.textContent = "";
    loadSelected();
  });
  const setAll = (on: boolean): void => {
    for (const box of list.querySelectorAll<HTMLInputElement>("input")) {
      box.checked = on;
      box.closest("li")?.classList.toggle("disabled", !on);
    }
    refresh();
  };
  checkAll.addEventListener("click", () => setAll(true));
  uncheckAll.addEventListener("click", () => setAll(false));
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
    // Requests share one queue with the model's turns, so a save can wait
    // behind a running turn; say so instead of looking dead.
    showStatus("saving…");
    waitingHint = setTimeout(
      () => showStatus("still waiting for the server…", false, true),
      4000,
    );
    actions.saveWhitelist(select.value, all ? undefined : tools);
  });

  return {
    refresh: open,
    showHooks(next) {
      hooks = next;
      drawHooks();
    },
    showStatus: (text, error) => showStatus(text, error),
    showWhitelist(name, allowed) {
      if (name !== select.value) return;
      renderWhitelist(list, actions, allowed);
      refresh();
    },
  };
}

/** Fill `list` with the tool checkboxes, grouped by category, ticking those in `allowed` (all when undefined). */
function renderWhitelist(
  list: HTMLUListElement,
  actions: ProfileEditorActions,
  allowed: string[] | undefined,
): void {
  list.textContent = "";
  let category: string | undefined;
  for (const tool of actions.toolNames()) {
    const next = actions.toolCategory(tool);
    if (next !== undefined && next !== category) {
      category = next;
      appendToolCategory(list, next);
    }
    appendToolItem(list, tool, allowed?.includes(tool) ?? true);
  }
}
