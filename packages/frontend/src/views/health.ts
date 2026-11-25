import { HealthResponseSchema } from "common";
import { apiJson } from "../api";
import { requireElement } from "../dom";

const health = requireElement("health") as HTMLParagraphElement;
const refresh = requireElement("refresh") as HTMLButtonElement;

export async function loadHealth(): Promise<void> {
  refresh.disabled = true;
  health.textContent = "Checking…";
  const result = await apiJson("/api/health", HealthResponseSchema);
  health.textContent = result.ok
    ? `${result.value.status} (${result.value.service}, checked ${new Date(result.value.time).toLocaleTimeString()})`
    : `Unavailable: ${result.error}`;
  refresh.disabled = false;
}

export function initHealth(): void {
  refresh.addEventListener("click", () => void loadHealth());
}
