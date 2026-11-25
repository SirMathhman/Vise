import type {
  ChatRequest,
  ChatStreamEvent,
  ErrorResponse,
  HealthResponse,
  ModelSummary,
  ModelsResponse,
  OpenRouterSettings,
  SaveOpenRouterKeyRequest,
} from "common";
import { greet } from "common";

// Backend base URL. Change this if the backend runs elsewhere.
const API_BASE = "http://localhost:3000";

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}

const greeting = requireElement("greeting") as HTMLParagraphElement;
const health = requireElement("health") as HTMLParagraphElement;
const refresh = requireElement("refresh") as HTMLButtonElement;

async function loadHealth(): Promise<void> {
  refresh.disabled = true;
  health.textContent = "Checking…";
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) {
      throw new Error(`HTTP ${String(res.status)}`);
    }
    const data = (await res.json()) as HealthResponse;
    health.textContent = `${data.status} (${data.service}, checked ${new Date(data.time).toLocaleTimeString()})`;
  } catch (err) {
    health.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    refresh.disabled = false;
  }
}

const modelsStatus = requireElement("models-status") as HTMLParagraphElement;
const modelsBody = requireElement("models-body") as HTMLTableSectionElement;
const modelOptions = requireElement("model-options") as HTMLDataListElement;
// Ids of the models loaded from the backend; the chat only accepts these.
const knownModelIds = new Set<string>();

const modelsPrev = requireElement("models-prev") as HTMLButtonElement;
const modelsNext = requireElement("models-next") as HTMLButtonElement;
const modelsPageLabel = requireElement("models-page");
// The table shows a fixed number of rows per page, so the whole page fits the window.
const MODELS_PAGE_SIZE = 5;
let models: ModelSummary[] = [];
let modelsPage = 0;

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

modelsPrev.addEventListener("click", () => {
  modelsPage -= 1;
  renderModelsPage();
});
modelsNext.addEventListener("click", () => {
  modelsPage += 1;
  renderModelsPage();
});

async function loadModels(): Promise<void> {
  modelsStatus.textContent = "Loading…";
  modelsBody.replaceChildren();
  try {
    const res = await fetch(`${API_BASE}/api/models`);
    if (!res.ok) {
      const err = (await res.json()) as ErrorResponse;
      throw new Error(err.error);
    }
    const data = (await res.json()) as ModelsResponse;
    models = data.models;
    modelsPage = 0;
    renderModelsPage();
    knownModelIds.clear();
    const options = data.models.map((m) => {
      knownModelIds.add(m.id);
      const option = document.createElement("option");
      option.value = m.id;
      option.label = m.name;
      return option;
    });
    modelOptions.replaceChildren(...options);
    modelsStatus.textContent = `${String(data.models.length)} models`;
  } catch (err) {
    modelsStatus.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const keyStatus = requireElement("key-status") as HTMLParagraphElement;
const keyForm = requireElement("key-form") as HTMLFormElement;
const keyInput = requireElement("key-input") as HTMLInputElement;
const keyClear = requireElement("key-clear") as HTMLButtonElement;
const keyError = requireElement("key-error") as HTMLParagraphElement;

// Sends a request and returns the parsed JSON body, or throws the backend's error message.
async function callApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  const body = (await res.json()) as T | ErrorResponse;
  if (!res.ok) {
    throw new Error((body as ErrorResponse).error);
  }
  return body as T;
}

function showKeyStatus(configured: boolean): void {
  keyStatus.textContent = configured ? "Key set" : "No key set";
}

async function loadKeyStatus(): Promise<void> {
  try {
    const settings = await callApi<OpenRouterSettings>(
      "/api/settings/openrouter",
    );
    showKeyStatus(settings.configured);
  } catch (err) {
    keyStatus.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function saveKey(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  keyError.textContent = "";
  const input: SaveOpenRouterKeyRequest = { apiKey: keyInput.value };
  try {
    const settings = await callApi<OpenRouterSettings>(
      "/api/settings/openrouter",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    keyInput.value = "";
    showKeyStatus(settings.configured);
    void loadModels();
  } catch (err) {
    keyError.textContent = err instanceof Error ? err.message : String(err);
  }
}

async function clearKey(): Promise<void> {
  keyError.textContent = "";
  try {
    const settings = await callApi<OpenRouterSettings>(
      "/api/settings/openrouter",
      { method: "DELETE" },
    );
    showKeyStatus(settings.configured);
    void loadModels();
  } catch (err) {
    keyError.textContent = err instanceof Error ? err.message : String(err);
  }
}

keyForm.addEventListener("submit", (event) => void saveKey(event));
keyClear.addEventListener("click", () => void clearKey());

const ACTIVE_MODEL_KEY = "vise.activeModel";
const modelInput = requireElement("model-input") as HTMLInputElement;
const chatMessage = requireElement("chat-message") as HTMLTextAreaElement;
const chatSend = requireElement("chat-send") as HTMLButtonElement;
const chatStatus = requireElement("chat-status") as HTMLParagraphElement;
const chatReply = requireElement("chat-reply") as HTMLDivElement;

// The active model is remembered in this browser only.
function readActiveModel(): string {
  try {
    return localStorage.getItem(ACTIVE_MODEL_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeActiveModel(id: string): void {
  try {
    localStorage.setItem(ACTIVE_MODEL_KEY, id);
  } catch {
    // Storage is unavailable; the choice still applies until the page reloads.
  }
}

modelInput.value = readActiveModel();
modelInput.addEventListener("change", () => {
  writeActiveModel(modelInput.value.trim());
});

// Applies one event from the reply stream. Returns true when the reply is over.
function applyChatEvent(event: ChatStreamEvent): boolean {
  if (event.type === "delta") {
    chatReply.textContent += event.text;
    return false;
  }
  chatStatus.textContent =
    event.type === "error" ? `Unavailable: ${event.message}` : "Done";
  return true;
}

// Reads the server-sent events until the reply's done or error event.
async function readReply(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let chunk = await reader.read();
  while (!chunk.done) {
    pending += decoder.decode(chunk.value, { stream: true });
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("data:")) {
        const event = JSON.parse(line.slice("data:".length)) as ChatStreamEvent;
        if (applyChatEvent(event)) {
          await reader.cancel();
          return;
        }
      }
    }
    chunk = await reader.read();
  }
  chatStatus.textContent = "The reply was cut off";
}

// Sends one message to the active model and shows the reply as it streams in.
async function sendMessage(): Promise<void> {
  const model = modelInput.value.trim();
  const message = chatMessage.value.trim();
  chatStatus.textContent = "";
  if (!knownModelIds.has(model)) {
    chatStatus.textContent = "Choose a model from the list.";
    return;
  }
  if (!message) {
    chatStatus.textContent = "Type a message first.";
    return;
  }

  const request: ChatRequest = { model, message };
  chatSend.disabled = true;
  chatReply.textContent = "";
  chatStatus.textContent = "Waiting for reply…";
  try {
    const res = await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!res.ok) {
      const err = (await res.json()) as ErrorResponse;
      throw new Error(err.error);
    }
    if (!res.body) {
      throw new Error("The reply had no body");
    }
    await readReply(res.body);
  } catch (err) {
    chatStatus.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    chatSend.disabled = false;
  }
}

chatSend.addEventListener("click", () => void sendMessage());

greeting.textContent = greet("frontend");
refresh.addEventListener("click", () => void loadHealth());
void loadHealth();
void loadModels();
void loadKeyStatus();
