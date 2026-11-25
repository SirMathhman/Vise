import type {
  ErrorResponse,
  HealthResponse,
  ModelsResponse,
  OpenRouterSettings,
  SaveOpenRouterKeyRequest,
} from "common";
import { greet } from "common";

// Backend base URL. Change this if the backend runs elsewhere.
const API_BASE = "http://localhost:3000";

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el as T;
}

const greeting = requireElement<HTMLParagraphElement>("greeting");
const health = requireElement<HTMLParagraphElement>("health");
const refresh = requireElement<HTMLButtonElement>("refresh");

async function loadHealth(): Promise<void> {
  refresh.disabled = true;
  health.textContent = "Checking…";
  try {
    const res = await fetch(`${API_BASE}/api/health`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = (await res.json()) as HealthResponse;
    health.textContent = `${data.status} (${data.service}, checked ${new Date(data.time).toLocaleTimeString()})`;
  } catch (err) {
    health.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    refresh.disabled = false;
  }
}

const modelsStatus = requireElement<HTMLParagraphElement>("models-status");
const modelsBody = requireElement<HTMLTableSectionElement>("models-body");

function cell(text: string): HTMLTableCellElement {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

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
    for (const m of data.models) {
      const row = document.createElement("tr");
      row.append(
        cell(m.id),
        cell(m.name),
        cell(m.contextLength.toLocaleString()),
        cell(`$${m.promptPricePerMillion.toFixed(2)}`),
        cell(`$${m.completionPricePerMillion.toFixed(2)}`),
      );
      modelsBody.append(row);
    }
    modelsStatus.textContent = `${data.models.length} models`;
  } catch (err) {
    modelsStatus.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

const keyStatus = requireElement<HTMLParagraphElement>("key-status");
const keyForm = requireElement<HTMLFormElement>("key-form");
const keyInput = requireElement<HTMLInputElement>("key-input");
const keyClear = requireElement<HTMLButtonElement>("key-clear");
const keyError = requireElement<HTMLParagraphElement>("key-error");

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
    const settings = await callApi<OpenRouterSettings>("/api/settings/openrouter");
    showKeyStatus(settings.configured);
  } catch (err) {
    keyStatus.textContent = `Unavailable: ${err instanceof Error ? err.message : String(err)}`;
  }
}

keyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  keyError.textContent = "";
  const input: SaveOpenRouterKeyRequest = { apiKey: keyInput.value };
  try {
    const settings = await callApi<OpenRouterSettings>("/api/settings/openrouter", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    keyInput.value = "";
    showKeyStatus(settings.configured);
    void loadModels();
  } catch (err) {
    keyError.textContent = err instanceof Error ? err.message : String(err);
  }
});

keyClear.addEventListener("click", async () => {
  keyError.textContent = "";
  try {
    const settings = await callApi<OpenRouterSettings>("/api/settings/openrouter", { method: "DELETE" });
    showKeyStatus(settings.configured);
    void loadModels();
  } catch (err) {
    keyError.textContent = err instanceof Error ? err.message : String(err);
  }
});

greeting.textContent = greet("frontend");
refresh.addEventListener("click", () => void loadHealth());
void loadHealth();
void loadModels();
void loadKeyStatus();
