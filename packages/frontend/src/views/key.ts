import type { OpenRouterSettings, SaveOpenRouterKeyRequest } from "common";
import { OpenRouterSettingsSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";
import { loadModels } from "./models";

const keyStatus = requireElement("key-status") as HTMLParagraphElement;
const keyForm = requireElement("key-form") as HTMLFormElement;
const keyInput = requireElement("key-input") as HTMLInputElement;
const keyClear = requireElement("key-clear") as HTMLButtonElement;
const keyError = requireElement("key-error") as HTMLParagraphElement;

const SETTINGS_PATH = "/api/settings/openrouter";

function showSettings(settings: OpenRouterSettings): void {
  keyStatus.textContent = settings.configured ? "Key set" : "No key set";
}

/**
 * Shows whether an OpenRouter key is configured.
 */
export async function loadKeyStatus(): Promise<void> {
  const result = await apiJson(SETTINGS_PATH, OpenRouterSettingsSchema);
  if (result.ok) {
    showSettings(result.value);
  } else {
    keyStatus.textContent = `Unavailable: ${result.error}`;
  }
}

async function saveKey(event: SubmitEvent): Promise<void> {
  event.preventDefault();
  keyError.textContent = "";
  const body: SaveOpenRouterKeyRequest = { apiKey: keyInput.value };
  const result = await apiJson(SETTINGS_PATH, OpenRouterSettingsSchema, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!result.ok) {
    keyError.textContent = result.error;
    return;
  }
  keyInput.value = "";
  showSettings(result.value);
  void loadModels();
}

async function clearKey(): Promise<void> {
  keyError.textContent = "";
  const result = await apiJson(SETTINGS_PATH, OpenRouterSettingsSchema, {
    method: "DELETE",
  });
  if (!result.ok) {
    keyError.textContent = result.error;
    return;
  }
  showSettings(result.value);
  void loadModels();
}

/**
 * Connects the key form's Save and Clear controls.
 */
export function initKey(): void {
  keyForm.addEventListener("submit", (event) => void saveKey(event));
  keyClear.addEventListener("click", () => void clearKey());
}
