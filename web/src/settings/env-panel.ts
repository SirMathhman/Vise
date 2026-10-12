import { theme, type ThemeChoice } from "../status/theme.ts";
import { THEME_CHOICES } from "../status/theme-choice.ts";
import { make } from "../dom.ts";

/** One setting as the server describes it (`env` message; see `src/settings/settings-file.ts`). */
interface EnvField {
  env: string;
  group: string;
  label: string;
  kind: "text" | "number";
  def: string | number;
  min?: number;
  value: string;
  secret: boolean;
  set: boolean;
  restart: boolean;
}

export interface EnvMessage {
  type: string;
  path?: string;
  fields?: EnvField[];
  saved?: boolean;
  error?: string;
}

/** The fields by group, groups in the order they first appear (a group split in the list is shown once). */
export function groupFields<T extends { group: string }>(fields: T[]): [string, T[]][] {
  const groups = new Map<string, T[]>();
  for (const field of fields) {
    const list = groups.get(field.group) ?? [];
    list.push(field);
    groups.set(field.group, list);
  }
  return [...groups];
}

/** The page's own settings (kept in this browser): only the theme for now. */
function appearance(): HTMLElement {
  const box = make("div");
  box.append(make("h2", "setting-group", "Appearance"));
  const row = make("label", "setting-row");
  const select = make("select", "field");
  for (const [value, label] of THEME_CHOICES) select.append(new Option(label, value));
  select.value = theme.choice();
  select.addEventListener("change", () => theme.set(select.value as ThemeChoice));
  theme.onChange(() => (select.value = theme.choice()));
  row.append(make("span", "", "Theme"), select, make("span", "badge", "this browser"));
  box.append(row);
  return box;
}

/** The boxes the general tab draws and what they held, shared by its rows. */
interface RowState {
  inputs: Map<string, HTMLInputElement>;
  shown: Map<string, string>;
  clearing: Set<string>;
  /** A box changed (the save bar follows). */
  changed(): void;
}

/** One setting: its label, a box with the default as the placeholder, and Clear (a saved secret) or a restart badge. */
function settingRow(field: EnvField, state: RowState): HTMLElement {
  const line = make("label", "setting-row");
  const input = make("input", "field");
  input.autocomplete = "off";
  if (field.secret) {
    input.type = "password";
    input.placeholder = field.set ? "Saved (type to replace)" : "Not set";
  } else {
    input.type = field.kind === "number" ? "number" : "text";
    if (field.kind === "number") {
      input.step = "any";
      if (field.min !== undefined) input.min = String(field.min);
    }
    input.placeholder = `Default: ${field.def}`;
    input.value = field.value;
  }
  input.title = field.env;
  input.addEventListener("input", state.changed);
  state.inputs.set(field.env, input);
  state.shown.set(field.env, input.value);
  line.append(make("span", "", field.label), input);
  if (field.secret && field.set) {
    const clear = make("button", "btn btn--sm", "Clear");
    clear.type = "button";
    clear.addEventListener("click", () => {
      state.clearing.add(field.env);
      input.placeholder = "Will be cleared on save";
      state.changed();
    });
    line.append(clear);
  } else if (field.restart) {
    line.append(make("span", "badge", "after restart"));
  }
  return line;
}

/**
 * The "general" settings tab: the theme, then every setting from the
 * user-level settings file (`~/.vise/.env`) in groups, with its default as the
 * placeholder. An empty box means the default. The save bar appears once
 * something changed; saving applies the values at once, and the few read only
 * at start-up say so. A secret is never sent back to the page: leaving its box
 * empty keeps the saved one.
 */
export function createEnvPanel(
  body: HTMLElement,
  send: (msg: Record<string, unknown>) => void,
  openers: HTMLElement[],
): { handle(message: EnvMessage): boolean } {
  const inputs = new Map<string, HTMLInputElement>();
  /** What each box held when it was drawn. */
  const shown = new Map<string, string>();
  /** Secrets the user asked to clear. */
  const clearing = new Set<string>();
  const status = make("span", "status-line");
  status.setAttribute("role", "status");
  const where = make("p", "hint");
  const theming = appearance();
  const save = make("button", "btn btn--primary", "Save changes");
  save.type = "button";
  const discard = make("button", "btn", "Discard");
  discard.type = "button";
  const bar = make("div", "actions editor-actions");
  bar.append(save, discard, status);
  let fields: EnvField[] = [];

  const changed = (): Record<string, string> => {
    const values: Record<string, string> = {};
    // Only what changed, so a stale page cannot revert other settings.
    for (const [env, input] of inputs) {
      if (input.value !== (shown.get(env) ?? "")) values[env] = input.value;
    }
    return values;
  };
  const syncBar = (): void => {
    const dirty = Object.keys(changed()).length > 0 || clearing.size > 0;
    save.disabled = !dirty;
    discard.disabled = !dirty;
    bar.classList.toggle("is-clean", !dirty && status.textContent === "");
  };

  const row = (field: EnvField): HTMLElement => settingRow(field, { inputs, shown, clearing, changed: syncBar });

  function render(): void {
    inputs.clear();
    shown.clear();
    clearing.clear();
    body.textContent = "";
    body.append(theming, where);
    for (const [group, members] of groupFields(fields)) {
      body.append(make("h2", "setting-group", group));
      for (const field of members) body.append(row(field));
    }
    body.append(bar);
    syncBar();
  }

  save.addEventListener("click", () => {
    status.textContent = "Saving…";
    status.classList.remove("error");
    send({ type: "env_set", values: changed(), clear: [...clearing] });
  });
  discard.addEventListener("click", () => {
    status.textContent = "";
    render();
  });
  for (const opener of openers) {
    opener.addEventListener("click", () => send({ type: "env_get" }));
  }
  send({ type: "env_get" });

  return {
    handle(message) {
      if (message.type !== "env") return false;
      // A refused save keeps what was typed, so it can be corrected.
      if (message.error) {
        status.textContent = `Not saved: ${message.error}`;
        status.classList.add("error");
        return true;
      }
      where.textContent = `Saved to ${message.path ?? ""}. Changes apply at once; an empty box means the default.`;
      fields = message.fields ?? [];
      status.textContent = message.saved ? "Saved." : "";
      render();
      return true;
    },
  };
}
