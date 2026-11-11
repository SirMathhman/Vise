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
    const needle = filter.value.trim().toLowerCase();
    const matching = models.filter((model) => model.id.toLowerCase().includes(needle));
    const nodes = groupsOf(doc, matching, current, models);
    select.replaceChildren(...nodes);
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
      if (next === key) return;
      key = next;
      current = nextCurrent;
      models = nextModels;
      draw();
    },
  };
}

// The options, one group per provider: a model's provider is the part of its name before the double colon. The
// current model is always offered, even when the filter hides it.
function groupsOf(doc: Document, matching: ModelInfo[], current: string, all: ModelInfo[]): HTMLElement[] {
  const groups = new Map<string, HTMLOptGroupElement>();
  const nodes: HTMLElement[] = [];
  for (const model of matching) {
    const at = model.id.indexOf("::");
    const provider = at < 0 ? "other" : model.id.slice(0, at);
    const label = at < 0 ? model.id : model.id.slice(at + 2);
    let group = groups.get(provider);
    if (group === undefined) {
      group = doc.createElement("optgroup");
      group.label = provider;
      groups.set(provider, group);
      nodes.push(group);
    }
    group.append(optionOf(doc, model.id, label));
  }
  if (current !== "" && !all.some((model) => model.id === current)) {
    nodes.unshift(optionOf(doc, current, current));
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
