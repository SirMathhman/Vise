import type { ErrorResponse, HealthResponse, ModelsResponse } from "common";
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

greeting.textContent = greet("frontend");
refresh.addEventListener("click", () => void loadHealth());
void loadHealth();
void loadModels();
