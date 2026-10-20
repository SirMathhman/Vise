import { ifConfirmed } from "../../feedback/confirm.ts";
import type { HooksFields } from "../hooks/hooks-panel.ts";
import { renderHookLists } from "../hooks/hook-lists.ts";
import { applyToggle, checkedTools, renderWhitelist, setAllTools } from "./whitelist.ts";
import { requiredElement as el } from "../../dom.ts";

export interface ProfileEditorActions {
  send(msg: Record<string, unknown>): void;
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
  /** The profile currently active, selected when the panel opens. */
  activeProfile(): string;
  /** The profile files changed (created, renamed, deleted): the header's choices follow. */
  profilesChanged(names: string[]): void;
}

/** The slice of a server message the editor reacts to. */
export interface ProfileMessage {
  type: string;
  ok?: boolean;
  error?: string;
  deleted?: boolean;
  name?: string;
  body?: string;
  profiles?: string[];
}

export interface ProfileEditor {
  /** Show the selected profile's own hooks (and add/remove them). */
  showHooks(hooks: HooksFields): void;
  /** Reload the profile list and the selected profile (the panel just opened). */
  refresh(): void;
  /** Briefly confirm a save (or report why it failed) next to the button. */
  showStatus(text: string, error?: boolean): void;
  /** Show a profile's whitelist; `undefined` means every tool is allowed. */
  showWhitelist(name: string, tools: string[] | undefined): void;
  handle(message: ProfileMessage): boolean;
}

/** The tab's elements (static in index.html). */
function elements() {
  return {
    list: el<HTMLUListElement>("pe-list"),
    form: el<HTMLElement>("pe-form"),
    empty: el<HTMLElement>("pe-empty"),
    name: el<HTMLInputElement>("pe-name"),
    body: el<HTMLTextAreaElement>("pe-body"),
    tools: el<HTMLUListElement>("pe-tools"),
    hooksBox: el<HTMLElement>("pe-hooks"),
    save: el<HTMLButtonElement>("pe-save"),
    del: el<HTMLButtonElement>("pe-delete"),
    status: el<HTMLElement>("pe-status"),
  };
}
type Ui = ReturnType<typeof elements>;

/** What the editor knows. */
interface EditorState {
  profiles: string[];
  /** The profile being edited; null while a new one is being written, "" when there is none. */
  current: string | null;
  hooks: HooksFields;
  /** The whitelist to save once the text is saved (the profile may not exist before); null when none waits. */
  pendingTools: string[] | undefined | null;
}

/** The selected profile's own hooks: they run only while it is active, in addition to the global ones. */
function drawHooks(ui: Ui, state: EditorState, editHook: (line: string) => void): void {
  ui.hooksBox.textContent = "";
  if (state.current === null) {
    ui.hooksBox.textContent = "Save the profile first, then add its own hooks here.";
    ui.hooksBox.className = "hint";
    return;
  }
  ui.hooksBox.className = "";
  const own = state.hooks.profileHooks?.[state.current] ?? { pre: [], post: [] };
  const labels = {
    pre: "Pre-turn hooks · only while this profile is active",
    post: "Post-turn hooks · only while this profile is active",
  };
  renderHookLists(ui.hooksBox, own, `/hooks profile ${state.current}`, labels, editHook);
}

/** The side list of profiles (the edited one marked), or the empty state when there are none. */
function drawList(ui: Ui, state: EditorState, select: (name: string) => void): void {
  ui.list.textContent = "";
  for (const profile of state.profiles) {
    const item = ui.list.appendChild(document.createElement("li"));
    const button = item.appendChild(document.createElement("button"));
    button.type = "button";
    button.className = "list-item";
    button.textContent = profile;
    if (profile === state.current) button.setAttribute("aria-current", "true");
    button.addEventListener("click", () => select(profile));
  }
  const none = state.profiles.length === 0 && state.current !== null;
  ui.empty.classList.toggle("hidden", !none);
  ui.form.classList.toggle("hidden", none);
}

/** The buttons beside the form that need no state: new profile, and ticking every tool or none. */
function wireToolButtons(ui: Ui, startNew: () => void): void {
  el<HTMLButtonElement>("pe-new").addEventListener("click", () => {
    startNew();
    ui.name.focus();
  });
  el<HTMLButtonElement>("pe-check-all").addEventListener("click", () =>
    setAllTools(ui.tools, true),
  );
  el<HTMLButtonElement>("pe-uncheck-all").addEventListener("click", () =>
    setAllTools(ui.tools, false),
  );
  ui.tools.addEventListener("change", (event) => applyToggle(ui.tools, event.target));
}

/** Ask, then delete the profile being edited (nothing when none is). */
function confirmDelete(target: string | null, send: ProfileEditorActions["send"]): void {
  if (!target) return;
  const title = `Delete the profile “${target}”?`;
  const message = "Its file, tool list and own hooks are removed. This cannot be undone.";
  ifConfirmed({ title, message }, () => send({ type: "profile_delete", name: target }));
}

/**
 * The profiles tab: a list of the profile files beside a form for the selected
 * one (its name, its instructions, the tools it may use and the hooks it owns).
 * The text goes straight to the profile store (`profile_*` messages); the
 * whitelist and hooks keep their own paths and are saved after it.
 */
export function createProfileEditor(actions: ProfileEditorActions): ProfileEditor {
  const ui = elements();
  const state: EditorState = { profiles: [], current: null, hooks: {}, pendingTools: null };
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  const showStatus = (text: string, error = false, sticky = false): void => {
    clearTimeout(statusTimer);
    ui.status.textContent = text;
    ui.status.classList.toggle("error", error);
    if (!sticky) statusTimer = setTimeout(() => (ui.status.textContent = ""), 3000);
  };
  const redraw = (): void => {
    drawList(ui, state, select);
    drawHooks(ui, state, actions.editHook);
  };
  const whitelist = (allowed: string[] | undefined): void =>
    renderWhitelist(ui.tools, actions.toolNames(), actions.toolCategory, allowed);

  /** Edit an existing profile (null: write a new one). */
  function select(profile: string | null): void {
    state.current = profile;
    ui.name.value = profile ?? "";
    ui.body.value = "";
    ui.body.placeholder =
      profile === null ? "Describe the persona or instructions for this profile…" : "Loading…";
    ui.del.disabled = profile === null;
    ui.status.textContent = "";
    if (profile === null) whitelist(undefined);
    else {
      actions.send({ type: "profile_get", name: profile });
      actions.loadWhitelist(profile);
    }
    redraw();
  }

  wireToolButtons(ui, () => select(null));
  ui.save.addEventListener("click", () => {
    const next = ui.name.value.trim();
    if (!next) return showStatus("A profile needs a name.", true);
    const ticked = checkedTools(ui.tools);
    if (ticked.length === 0) return showStatus("Allow at least one tool.", true);
    // Every tool ticked means no restriction.
    state.pendingTools = ticked.length === actions.toolNames().length ? undefined : ticked;
    showStatus("Saving…", false, true);
    actions.send({
      type: "profile_save",
      name: next,
      body: ui.body.value,
      from: state.current ?? undefined,
    });
  });
  ui.del.addEventListener("click", () => confirmDelete(state.current, actions.send));

  function handleResult(message: ProfileMessage): void {
    if (!message.ok) return showStatus(message.error ?? "Failed.", true, true);
    showStatus(message.deleted ? "Deleted." : "Saved.");
    state.current = message.deleted ? "" : (message.name ?? "");
    if (message.deleted) return;
    ui.del.disabled = false;
    if (state.pendingTools !== null) actions.saveWhitelist(state.current, state.pendingTools);
    state.pendingTools = null;
    drawHooks(ui, state, actions.editHook);
  }

  function handleList(profiles: string[]): void {
    state.profiles = profiles;
    actions.profilesChanged(profiles);
    if (state.current !== null && profiles.includes(state.current))
      return drawList(ui, state, select);
    if (profiles.length === 0) {
      state.current = "";
      return redraw();
    }
    const active = actions.activeProfile();
    select(profiles.includes(active) ? active : (profiles[0] ?? ""));
  }

  return {
    refresh() {
      actions.send({ type: "profiles_list" });
      actions.loadHooks();
    },
    showHooks(next) {
      state.hooks = next;
      drawHooks(ui, state, actions.editHook);
    },
    showStatus: (text, error) => showStatus(text, error),
    showWhitelist(profile, allowed) {
      if (profile === state.current) whitelist(allowed);
    },
    handle(message) {
      if (message.type === "profiles") handleList(message.profiles ?? []);
      else if (message.type === "profile_result") handleResult(message);
      else if (message.type !== "profile") return false;
      else if (message.name === state.current) {
        ui.body.value = message.body ?? "";
        ui.body.placeholder = "";
      }
      return true;
    },
  };
}
