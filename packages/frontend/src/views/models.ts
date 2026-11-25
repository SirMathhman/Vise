import type { ModelSummary } from "common";
import { ModelsResponseSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const modelsStatus = requireElement("models-status") as HTMLParagraphElement;
const modelsBody = requireElement("models-body") as HTMLTableSectionElement;
const modelOptions = requireElement("model-options") as HTMLDataListElement;
const modelsPrev = requireElement("models-prev") as HTMLButtonElement;
const modelsNext = requireElement("models-next") as HTMLButtonElement;
const modelsPageLabel = requireElement("models-page");

// The table shows a fixed number of rows per page, so the whole page fits the window.
const MODELS_PAGE_SIZE = 3;
let models: ModelSummary[] = [];
let modelsPage = 0;

// The loaded models and their context windows in tokens. The chat only accepts these.
const knownModels = new Map<string, number>();

/**
 * Whether a model is in the loaded list.
 *
 * @param id The model id to check.
 * @returns True when the model is loaded.
 */
export function hasModel(id: string): boolean {
  return knownModels.has(id);
}

/**
 * The context window of a loaded model, or undefined when the model is not loaded.
 *
 * @param id The model id to look up.
 * @returns The context window in tokens, or undefined when the model is not loaded.
 */
export function contextLengthOf(id: string): number | undefined {
  return knownModels.get(id);
}

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

// A null price means OpenRouter prices this model per request, not per token.
function priceText(perMillion: number | null): string {
  return perMillion === null ? "varies" : `$${perMillion.toFixed(2)}`;
}

function modelRow(m: ModelSummary): HTMLTableRowElement {
  const row = document.createElement("tr");
  // Model ids have the form "vendor/model"; the vendor is the part before the slash.
  row.append(
    cell(m.id.split("/")[0]),
    cell(m.name),
    cell(m.contextLength.toLocaleString()),
    cell(priceText(m.promptPricePerMillion)),
    cell(priceText(m.completionPricePerMillion)),
  );
  return row;
}

function renderModelsPage(): void {
  const pageCount = Math.max(1, Math.ceil(models.length / MODELS_PAGE_SIZE));
  const start = modelsPage * MODELS_PAGE_SIZE;
  modelsBody.replaceChildren(
    ...models.slice(start, start + MODELS_PAGE_SIZE).map(modelRow),
  );
  modelsPageLabel.textContent = `Page ${String(modelsPage + 1)} of ${String(pageCount)}`;
  modelsPrev.disabled = modelsPage === 0;
  modelsNext.disabled = modelsPage >= pageCount - 1;
}

/**
 * Loads the OpenRouter model list into the table, the model picker, and the chat's list of known models.
 */
export async function loadModels(): Promise<void> {
  modelsStatus.textContent = "Loading…";
  modelsBody.replaceChildren();
  const result = await apiJson("/api/models", ModelsResponseSchema);
  if (!result.ok) {
    modelsStatus.textContent = `Unavailable: ${result.error}`;
    return;
  }
  models = result.value.models;
  modelsPage = 0;
  renderModelsPage();

  knownModels.clear();
  const options = models.map((m) => {
    knownModels.set(m.id, m.contextLength);
    const option = document.createElement("option");
    option.value = m.id;
    option.label = m.name;
    return option;
  });
  modelOptions.replaceChildren(...options);
  modelsStatus.textContent = `${String(models.length)} models`;
}

/**
 * Connects the models table's pager.
 */
export function initModels(): void {
  modelsPrev.addEventListener("click", () => {
    modelsPage -= 1;
    renderModelsPage();
  });
  modelsNext.addEventListener("click", () => {
    modelsPage += 1;
    renderModelsPage();
  });
}
