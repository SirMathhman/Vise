import type { ServerMessage } from "../server-message.ts";
import { make } from "../dom.ts";
import { storage } from "../storage.ts";

/** One model as the server lists it (`ModelDetail` in src/client/llm.ts). */
export interface ModelEntry {
  id: string;
  name?: string;
  contextLength?: number;
  vision: boolean;
  /** Where the model runs: "local" (llama.cpp) or "openrouter". */
  provider?: string;
}

/** The fields of a `model_list` / `model_set` reply that the picker reads (src/web/api/model-api.ts). */
interface ModelReply {
  type: string;
  models?: ModelEntry[];
  active?: string;
  ok?: boolean;
  error?: string;
}

export interface ModelPickerParts {
  button: HTMLButtonElement;
  panel: HTMLElement;
  search: HTMLInputElement;
  recent: HTMLElement;
  recentList: HTMLUListElement;
  list: HTMLUListElement;
  send(message: Record<string, unknown>): void;
  close(): void;
  /** A model was chosen in the picker (the chat log echoes it, as `/model` does). */
  onChoose(id: string): void;
  /** The server refused a switch (the picker shows the model that is still active). */
  onError(text: string): void;
}

export interface ModelPicker {
  /** Takes a `model_list` or `model_set` reply; false for any other message. */
  handle(message: ServerMessage): boolean;
  /** The panel opened: fetch the list again and start a fresh search. */
  refresh(): void;
  /** The ids the server listed, for the composer's suggestions. */
  modelIds(): string[];
  /** The model was switched some other way (the `/model` command). */
  setActive(id: string): void;
}

const RECENT_KEY = "vise-recent-models";
const RECENT_MAX = 5;

/** The recently picked model ids, newest first. Storage may be blocked (a private window): then none. */
function readRecent(): string[] {
  try {
    const value: unknown = JSON.parse(storage.get(RECENT_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.filter((id): id is string => typeof id === "string").slice(0, RECENT_MAX);
  } catch {
    return []; // not JSON: start over
  }
}

function rememberRecent(id: string): void {
  const next = [id, ...readRecent().filter((other) => other !== id)].slice(0, RECENT_MAX);
  storage.set(RECENT_KEY, JSON.stringify(next));
}

/** "200K ctx", "1M ctx": a context window in tokens, rounded. */
export function contextLabel(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M ctx`;
  return `${Math.round(tokens / 1000)}K ctx`;
}

/** One model as a row: its name (the id under it when a name is shown), then its context and vision badges. */
function modelRow(model: ModelEntry, active: string, choose: (id: string) => void): HTMLLIElement {
  const item = make("li");
  const choice = make("button", "list-item model-item");
  choice.type = "button";
  choice.title = model.id;
  if (model.id === active) choice.setAttribute("aria-current", "true");
  const text = make("span", "model-text");
  text.append(make("span", "model-name", model.name || model.id));
  // A bare id is already the name, so the id is the subtitle only when a name is shown above it.
  if (model.name) text.append(make("span", "model-id", model.id));
  const meta = make("span", "model-meta");
  if (model.contextLength) meta.append(make("span", "badge badge--sm", contextLabel(model.contextLength)));
  if (model.provider === "openrouter") meta.append(make("span", "badge badge--sm", "OpenRouter"));
  if (model.vision) meta.append(make("span", "badge badge--sm", "vision"));
  choice.append(text, meta);
  choice.addEventListener("click", () => choose(model.id));
  item.append(choice);
  return item;
}

/** Arrow keys move between the rows of the panel (recent and full list alike). */
function moveFocus(panel: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = Array.from(panel.querySelectorAll<HTMLButtonElement>(".model-item"));
  if (items.length === 0) return;
  event.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const step = event.key === "ArrowDown" ? 1 : -1;
  const next = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
  items[next]?.focus();
}

/** The model button and its panel: a search box, the recently used models, and the full list. */
export function createModelPicker(parts: ModelPickerParts): ModelPicker {
  const { button, panel, search, recent, recentList, list, send, close, onChoose, onError } = parts;
  let models: ModelEntry[] = [];
  let active = "";
  let loaded = false;
  let failure: string | undefined;
  /** The main list as last drawn: Enter picks its first entry. */
  let shown: ModelEntry[] = [];

  const showActive = (): void => {
    if (active) {
      const found = models.find((model) => model.id === active);
      button.textContent = found?.name || active;
      button.title = active;
    } else if (failure !== undefined) {
      button.textContent = "Models unavailable";
      button.title = failure;
    } else if (loaded) {
      button.textContent = "No model";
      button.title = "No model is active";
    }
  };

  const setActive = (id: string): void => {
    active = id;
    rememberRecent(id);
    showActive();
    render();
  };

  const choose = (id: string): void => {
    send({ type: "model_set", model: id });
    setActive(id);
    close();
    onChoose(id);
  };

  function render(): void {
    const query = search.value.trim().toLowerCase();
    shown = models.filter(
      (model) =>
        !query || model.id.toLowerCase().includes(query) || (model.name ?? "").toLowerCase().includes(query),
    );
    list.textContent = "";
    if (failure !== undefined) list.append(make("li", "list-empty", `Could not load models: ${failure}`));
    else if (!loaded) list.append(make("li", "list-empty", "Loading…"));
    else if (shown.length === 0)
      list.append(make("li", "list-empty", models.length === 0 ? "No models available" : "No model matches the search"));
    else for (const model of shown) list.append(modelRow(model, active, choose));

    // "Recently used" shows while nothing is typed; ids the list no longer has are skipped.
    recentList.textContent = "";
    const picks = query
      ? []
      : readRecent()
          .map((id) => models.find((model) => model.id === id))
          .filter((model): model is ModelEntry => model !== undefined);
    for (const model of picks) recentList.append(modelRow(model, active, choose));
    recent.classList.toggle("hidden", picks.length === 0);
  }

  search.addEventListener("input", render);
  search.addEventListener("keydown", (event) => {
    // Enter picks the first match, once something is typed (an empty box would pick the top of the list).
    if (event.key === "Enter" && search.value.trim() && shown[0]) {
      event.preventDefault();
      choose(shown[0].id);
    }
  });
  panel.addEventListener("keydown", (event) => moveFocus(panel, event));

  return {
    handle(message) {
      const reply = message as unknown as ModelReply;
      if (reply.type === "model_list") {
        loaded = true;
        if (reply.error !== undefined) failure = reply.error;
        else {
          failure = undefined;
          models = reply.models ?? [];
        }
        if (reply.active) active = reply.active;
        showActive();
        render();
        return true;
      }
      if (reply.type === "model_set") {
        if (reply.ok && reply.active) setActive(reply.active);
        else if (!reply.ok) {
          // Refused: show what is still active, not the model that was clicked.
          if (reply.active) setActive(reply.active);
          onError(reply.error ?? "could not switch model");
        }
        return true;
      }
      return false;
    },
    refresh() {
      search.value = "";
      send({ type: "model_list" });
      render();
      search.focus();
    },
    modelIds: () => models.map((model) => model.id),
    setActive,
  };
}
