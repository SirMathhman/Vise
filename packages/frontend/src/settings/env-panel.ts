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
  /** Where suggestions for the value come from (a combobox); `local-models`: the local server's models. */
  choices?: string;
}

/** One suggestion for a combobox. */
export interface EnvOption {
  value: string;
  label: string;
}

export interface EnvMessage {
  type: string;
  path?: string;
  fields?: EnvField[];
  saved?: boolean;
  error?: string;
  /** `env_choices`: which source this answers, and what it offers. */
  source?: string;
  offers?: EnvOption[];
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

/** Replace the entries of a combobox's suggestion list. */
function fillList(list: HTMLDataListElement | undefined, options: EnvOption[]): void {
  if (!list) return;
  list.textContent = "";
  for (const option of options) {
    const entry = new Option(option.label, option.value);
    entry.label = option.label;
    list.append(entry);
  }
}

/** The boxes the general tab draws and what they held, shared by its rows. */
interface RowState {
  inputs: Map<string, HTMLInputElement>;
  shown: Map<string, string>;
  clearing: Set<string>;
  /** The suggestion lists of the comboboxes, by source. */
  lists: Map<string, HTMLDataListElement>;
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
  if (field.choices && !field.secret) {
    // A combobox: type anything, or pick what the source offers (filled when its answer arrives).
    let list = state.lists.get(field.choices);
    if (!list) {
      list = make("datalist");
      list.id = `env-choices-${field.choices}`;
      state.lists.set(field.choices, list);
    }
    input.setAttribute("list", list.id);
    input.placeholder = `Default: ${field.def || "the default local model"} (type, or pick one)`;
    line.append(list);
  }
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
  const lists = new Map<string, HTMLDataListElement>();
  /** What each source last answered, kept so a re-drawn page shows it at once. */
  const offered = new Map<string, EnvOption[]>();
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

  const row = (field: EnvField): HTMLElement => settingRow(field, { inputs, shown, clearing, lists, changed: syncBar });

  const fill = (source: string): void => fillList(lists.get(source), offered.get(source) ?? []);

  function render(): void {
    inputs.clear();
    shown.clear();
    clearing.clear();
    lists.clear();
    body.textContent = "";
    body.append(theming, where);
    for (const [group, members] of groupFields(fields)) {
      body.append(make("h2", "setting-group", group));
      for (const field of members) body.append(row(field));
    }
    body.append(bar);
    syncBar();
    // Comboboxes show what they last heard at once, and ask again (the server's models can change).
    for (const source of lists.keys()) {
      fill(source);
      send({ type: "env_choices", source });
    }
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
      if (message.type === "env_choices") {
        const source = message.source ?? "";
        offered.set(source, message.offers ?? []);
        fill(source);
        for (const [env, input] of inputs) {
          const field = fields.find((f) => f.env === env);
          if (field?.choices === source) {
            input.title = message.error ? `${env}: could not list the models (${message.error})` : env;
          }
        }
        return true;
      }
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
