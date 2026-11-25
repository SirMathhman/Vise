import type { Hooks, HooksResponse } from "common";
import {
  HooksResponseSchema,
  HooksSchema,
  NotesResponseSchema,
  PROFILE_CATEGORY,
} from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const hooksStatus = requireElement("hooks-status") as HTMLParagraphElement;
const scopeSelect = requireElement("hooks-scope") as HTMLSelectElement;
const hooksForm = requireElement("hooks-form") as HTMLFormElement;
const hooksError = requireElement("hooks-error") as HTMLParagraphElement;

// The scope value of the global commands. Profile scopes use the profile's id.
const GLOBAL = "global";

// One command field on the form, and the event it sets.
interface HookField {
  name: keyof Hooks;
  input: HTMLInputElement;
}

const FIELDS: HookField[] = [
  {
    name: "beforeSession",
    input: requireElement("hooks-before-session") as HTMLInputElement,
  },
  {
    name: "afterSession",
    input: requireElement("hooks-after-session") as HTMLInputElement,
  },
  {
    name: "beforeTurn",
    input: requireElement("hooks-before-turn") as HTMLInputElement,
  },
  {
    name: "afterTurn",
    input: requireElement("hooks-after-turn") as HTMLInputElement,
  },
];

// The commands as last loaded or saved.
let hooks: HooksResponse = { global: {}, profiles: {} };

// Shows the commands of the chosen scope in the form.
function showScope(): void {
  const scope = scopeSelect.value;
  const current: Hooks =
    scope === GLOBAL ? hooks.global : (hooks.profiles[scope] ?? {});
  for (const field of FIELDS) {
    field.input.value = current[field.name] ?? "";
  }
}

/**
 * Loads the commands and the profiles to choose a scope from. Unsaved edits stay in the form
 * unless the scope itself changes.
 */
export async function loadHooks(): Promise<void> {
  const result = await apiJson("/api/hooks", HooksResponseSchema);
  if (!result.ok) {
    hooksStatus.textContent = `Unavailable: ${result.error}`;
    return;
  }
  hooks = result.value;
  const notes = await apiJson("/api/notes", NotesResponseSchema);
  const profiles = notes.ok
    ? notes.value.notes.filter((note) => note.category === PROFILE_CATEGORY)
    : [];
  const previous = scopeSelect.value;
  scopeSelect.replaceChildren(
    new Option("Global", GLOBAL),
    ...profiles.map((p) => new Option(p.name, p.id)),
  );
  const scopes = [GLOBAL, ...profiles.map((p) => p.id)];
  scopeSelect.value = scopes.includes(previous) ? previous : GLOBAL;
  if (scopeSelect.value !== previous) {
    showScope();
  }
  hooksStatus.textContent = "";
}

async function saveHooks(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  hooksError.textContent = "";
  const body: Hooks = {};
  for (const field of FIELDS) {
    const value = field.input.value.trim();
    if (value !== "") {
      body[field.name] = value;
    }
  }
  const scope = scopeSelect.value;
  const path =
    scope === GLOBAL
      ? "/api/hooks/global"
      : `/api/hooks/profiles/${encodeURIComponent(scope)}`;
  const result = await apiJson(path, HooksSchema, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    hooksError.textContent = result.error;
    return;
  }
  if (scope === GLOBAL) {
    hooks.global = result.value;
  } else {
    hooks.profiles[scope] = result.value;
  }
  hooksStatus.textContent = "Saved";
}

/**
 * Connects the scope picker, the command fields, and the save button.
 */
export function initHooks(): void {
  scopeSelect.addEventListener("change", () => {
    hooksError.textContent = "";
    showScope();
  });
  scopeSelect.addEventListener("focus", () => void loadHooks());
  hooksForm.addEventListener("submit", (event) => void saveHooks(event));
}
