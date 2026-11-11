import type { ModelInfo } from "../../../protocol/protocol.ts";

// The model selector in the header: the models grouped by provider, with a filter. Choosing one sends /model, as
// typing it would, so the page keeps to lines.

export interface ModelActions {
  chooseModel(name: string): void;
}

export interface ModelPicker {
  element: HTMLElement;
  update(current: string, models: ModelInfo[], enabled: boolean): void;
}

export function createModelPicker(doc: Document, actions: ModelActions): ModelPicker {
  const element = doc.createElement("div");
  element.className = "model-picker";
  const filter = doc.createElement("input");
  filter.type = "search";
  filter.placeholder = "filter models";
  filter.setAttribute("aria-label", "Filter models");
  const select = doc.createElement("select");
  select.className = "model-select";
  select.setAttribute("aria-label", "Model");
  element.append(filter, select);
  let key = "";
  let current = "";
  let models: ModelInfo[] = [];

  function draw(): void {
    select.replaceChildren(...groupsOf(doc, offered(models, current, filter.value.trim().toLowerCase())));
    select.value = current;
  }

  filter.addEventListener("input", draw);
  select.addEventListener("change", () => {
    if (select.value !== current) actions.chooseModel(select.value);
  });

  return {
    element,
    update(nextCurrent, nextModels, enabled) {
      select.disabled = !enabled;
      const next = JSON.stringify([nextCurrent, nextModels]);
      // An unchanged list keeps its options, but the select follows the session: a refused /model leaves the old model.
      if (next === key) {
        select.value = nextCurrent;
        return;
      }
      key = next;
      current = nextCurrent;
      models = nextModels;
      draw();
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
export interface Place {
  group: string;
  label: string;
}

export function placeOf(id: string): Place {
  const at = id.indexOf("::");
  const provider = at < 0 ? "other" : id.slice(0, at);
  const name = at < 0 ? id : id.slice(at + 2);
  const slash = name.indexOf("/");
  if (slash < 0) return { group: provider, label: name };
  return { group: `${provider} · ${name.slice(0, slash)}`, label: name.slice(slash + 1) };
}

// The options in alphabetical order, one group per provider and vendor.
function groupsOf(doc: Document, ids: string[]): HTMLElement[] {
  const groups = new Map<string, HTMLOptGroupElement>();
  const nodes: HTMLElement[] = [];
  for (const id of [...ids].sort((a, b) => a.localeCompare(b))) {
    const { group, label } = placeOf(id);
    let node = groups.get(group);
    if (node === undefined) {
      node = doc.createElement("optgroup");
      node.label = group;
      groups.set(group, node);
      nodes.push(node);
    }
    node.append(optionOf(doc, id, label));
  }
  if (nodes.length === 0) nodes.push(optionOf(doc, "", "no models: add a provider"));
  return nodes;
}

function optionOf(doc: Document, value: string, label: string): HTMLOptionElement {
  const option = doc.createElement("option");
  option.value = value;
  option.textContent = label;
  return option;
}
