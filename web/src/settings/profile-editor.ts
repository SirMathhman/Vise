import type { HooksFields } from "./hooks-panel.ts";
import {
  appendToolCategory,
  appendToolItem,
  syncCategoryToggles,
} from "./panels.ts";
import { renderHookLists } from "./hook-lists.ts";

export interface ProfileEditorActions {
  /** Ask the server for the global hooks and each profile's own hooks. */
  loadHooks(): void;
  /** Send a `/hooks profile <name> add|remove ...` line. */
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
  /** Show the selected profile's own hooks (and add/remove them). */
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
    renderOwnHooks(hooksBox, hooks, select.value, actions.editHook);

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
      // The category checkboxes only switch groups; they are not tools.
      list.querySelectorAll<HTMLInputElement>(
        "li:not(.tool-category) input:checked",
      ),
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
    syncCategoryToggles(list);
    refresh();
  };
  checkAll.addEventListener("click", () => setAll(true));
  uncheckAll.addEventListener("click", () => setAll(false));
  list.addEventListener("change", (event) => {
    applyToggle(list, event.target);
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

/** Tick or untick every tool under a category heading row. */
function setGroup(head: Element, on: boolean): void {
  for (let row = head.nextElementSibling; row; row = row.nextElementSibling) {
    if (row.classList.contains("tool-category")) break;
    const box = row.querySelector<HTMLInputElement>("input");
    if (box) box.checked = on;
    row.classList.toggle("disabled", !on);
  }
}

/** A checkbox in the list changed: a tool dims its row, a category switches its whole group; then the category boxes are re-synced. */
function applyToggle(list: HTMLUListElement, target: EventTarget | null): void {
  if (target instanceof HTMLInputElement) {
    const row = target.closest("li");
    if (row?.classList.contains("tool-category")) setGroup(row, target.checked);
    else row?.classList.toggle("disabled", !target.checked);
  }
  syncCategoryToggles(list);
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
      appendToolCategory(list, next, true);
    }
    appendToolItem(list, tool, allowed?.includes(tool) ?? true);
  }
  syncCategoryToggles(list);
}

/** The selected profile's own hooks: they run only while it is active, in addition to the global ones. */
function renderOwnHooks(
  box: HTMLElement,
  hooks: HooksFields,
  name: string,
  edit: (line: string) => void,
): void {
  box.textContent = "";
  if (!name) return;
  const own = hooks.profileHooks?.[name] ?? { pre: [], post: [] };
  const labels = {
    pre: `pre-turn hooks for '${name}' (run only while this profile is active)`,
    post: `post-turn hooks for '${name}' (run only while this profile is active)`,
  };
  renderHookLists(box, own, `/hooks profile ${name}`, labels, edit);
}
