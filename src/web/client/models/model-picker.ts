import type { ModelInfo } from "../../../protocol/protocol.ts";

// The model selector in the header: an autocomplete combobox. Typing filters the models, grouped by provider and
// vendor; the arrow keys move through them, Enter or a click chooses one, and Escape or leaving the box keeps the
// session's model. Choosing sends /model, as typing it would, so the page keeps to lines.

export interface ModelActions {
  chooseModel(name: string): void;
}

export interface ModelPicker {
  element: HTMLElement;
  update(current: string, models: ModelInfo[], enabled: boolean): void;
}

export interface Place {
  group: string;
  label: string;
}

let pickers = 0;

export function createModelPicker(doc: Document, actions: ModelActions): ModelPicker {
  pickers += 1;
  const listId = `model-list-${pickers}`;
  const element = doc.createElement("div");
  element.className = "model-picker";
  const input = doc.createElement("input");
  input.type = "text";
  input.className = "model-input";
  input.placeholder = "choose a model";
  input.autocomplete = "off";
  const aria = { role: "combobox", "aria-label": "Model", "aria-autocomplete": "list", "aria-controls": listId, "aria-expanded": "false" };
  for (const [name, value] of Object.entries(aria)) input.setAttribute(name, value);
  const list = doc.createElement("ul");
  list.id = listId;
  list.className = "model-list";
  list.setAttribute("role", "listbox");
  list.hidden = true;
  element.append(input, list);

  let current = "";
  let models: ModelInfo[] = [];
  let open = false;
  // Whether the user has typed since the box was last entered; only then does the typed text filter the list.
  let typed = false;
  let active = -1;
  let visible: string[] = [];

  function needle(): string {
    return typed ? input.value.trim().toLowerCase() : "";
  }

  function setActive(index: number): void {
    active = index;
    if (index >= 0 && index < visible.length) input.setAttribute("aria-activedescendant", `${listId}-${index}`);
    else input.removeAttribute("aria-activedescendant");
    list.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function renderList(): void {
    visible = offered(models, current, needle()).sort((a, b) => byPlace(a, b));
    const empty = models.length === 0 ? "no models: add a provider" : "no model matches";
    list.replaceChildren(...listNodes(doc, { listId, ids: visible, current, active, empty }));
    if (active >= visible.length) setActive(-1);
  }

  function setOpen(next: boolean): void {
    open = next;
    list.hidden = !next;
    input.setAttribute("aria-expanded", String(next));
    if (next) renderList();
    else setActive(-1);
  }

  function choose(id: string): void {
    typed = false;
    setOpen(false);
    if (id !== current) {
      input.value = id;
      actions.chooseModel(id);
    }
  }

  // Keeps the session's model in the box, and forgets what was typed.
  function revert(): void {
    typed = false;
    input.value = current;
    setOpen(false);
  }

  input.addEventListener("focus", () => {
    typed = false;
    setOpen(true);
    input.select();
  });
  input.addEventListener("input", () => {
    typed = true;
    if (!open) setOpen(true);
    else renderList();
    setActive(visible.length > 0 ? 0 : -1);
  });
  input.addEventListener("blur", revert);
  input.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else if (visible.length > 0) setActive(wrap(active + (event.key === "ArrowDown" ? 1 : -1), visible.length));
    } else if (event.key === "Enter" && open && visible[active] !== undefined) {
      event.preventDefault();
      choose(visible[active] ?? current);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      revert();
    }
  });
  // A press on the list keeps the box focused, so the blur does not close the list before the click lands.
  list.addEventListener("mousedown", (event) => event.preventDefault());
  list.addEventListener("click", (event) => {
    const option = (event.target as Element).closest<HTMLElement>("[data-value]");
    if (option?.dataset.value !== undefined) choose(option.dataset.value);
  });

  return {
    element,
    update(nextCurrent, nextModels, enabled) {
      input.disabled = !enabled;
      current = nextCurrent;
      models = nextModels;
      if (!typed) input.value = current;
      if (open) renderList();
    },
  };
}

// The model ids the selector offers: those the filter (lower case) matches, and the current model even when the
// filter hides it, so the selector always shows what the session is on.
export function offered(models: ModelInfo[], current: string, needle: string): string[] {
  const ids = models.map((model) => model.id).filter((id) => id.toLowerCase().includes(needle));
  return current !== "" && !ids.includes(current) ? [current, ...ids] : ids;
}

// The group and the option label of a model id. The group is its provider, then its vendor (the part of its name
// before the first slash), so a long provider list is grouped by vendor too. A name with no slash is grouped by its
// provider alone.
export function placeOf(id: string): Place {
  const at = id.indexOf("::");
  const provider = at < 0 ? "other" : id.slice(0, at);
  const name = at < 0 ? id : id.slice(at + 2);
  const slash = name.indexOf("/");
  if (slash < 0) return { group: provider, label: name };
  return { group: `${provider} · ${name.slice(0, slash)}`, label: name.slice(slash + 1) };
}

// Alphabetical by group, then by label, so each group is one run.
function byPlace(a: string, b: string): number {
  const pa = placeOf(a);
  const pb = placeOf(b);
  return pa.group.localeCompare(pb.group) || pa.label.localeCompare(pb.label);
}

function wrap(index: number, length: number): number {
  return (index + length) % length;
}

interface ListParts {
  listId: string;
  ids: string[];
  current: string;
  active: number;
  empty: string;
}

// The list's contents: a heading for each group, then its models, or a message when there are none.
function listNodes(doc: Document, parts: ListParts): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  let group = "";
  parts.ids.forEach((id, index) => {
    const place = placeOf(id);
    if (place.group !== group) {
      group = place.group;
      nodes.push(headingOf(doc, group));
    }
    nodes.push(
      optionOf(doc, {
        optionId: `${parts.listId}-${index}`,
        model: id,
        index,
        label: place.label,
        selected: id === parts.current,
        active: index === parts.active,
      }),
    );
  });
  if (nodes.length === 0) nodes.push(headingOf(doc, parts.empty));
  return nodes;
}

function headingOf(doc: Document, text: string): HTMLElement {
  const heading = doc.createElement("li");
  heading.className = "model-group";
  heading.setAttribute("role", "presentation");
  heading.textContent = text;
  return heading;
}

interface OptionParts {
  optionId: string;
  model: string;
  index: number;
  label: string;
  selected: boolean;
  active: boolean;
}

function optionOf(doc: Document, parts: OptionParts): HTMLElement {
  const option = doc.createElement("li");
  option.id = parts.optionId;
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", String(parts.active));
  option.dataset.index = String(parts.index);
  option.dataset.value = parts.model;
  option.textContent = parts.selected ? `${parts.label} (current)` : parts.label;
  if (parts.active) option.classList.add("active");
  return option;
}
