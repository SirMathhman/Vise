import type { ModelInfo } from "../../core/messages.ts";
import type { Emit } from "../../protocol/protocol.ts";
import type { SessionPorts } from "../ports.ts";

// The models the page's selector shows. Each function answers with events and never throws.

// Reads the models the providers list, at the start of a session. A failure is reported, and the list is empty.
export async function loadModels(ports: SessionPorts, emit: Emit): Promise<ModelInfo[]> {
  const listed = await ports.models.list();
  if (!listed.ok) {
    emit({ kind: "error", message: `could not list the models: ${listed.error.message}` });
    return [];
  }
  return listed.value;
}

// Sends the current model and the models the selector offers. Sent at the start and after each command, so the
// selector shows a change made with /model.
export function announceModels(ports: SessionPorts, emit: Emit, models: ModelInfo[]): void {
  emit({ kind: "models", current: ports.models.current(), models });
}
