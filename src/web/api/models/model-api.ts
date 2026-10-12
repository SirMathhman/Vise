import type { ModelPickerPorts } from "../../../wiring.ts";
import { formatError } from "../../../output/format.ts";

/**
 * The model picker's messages, answered at once and never queued behind a turn:
 *   browser → server: { type: "model_list" }
 *                     { type: "model_set", model }
 *   server → browser: { type: "model_list", models, active }
 *                     { type: "model_list", error }
 *                     { type: "model_set", ok: true, active }
 * The picker needs to respond instantly even mid-turn, so these bypass the
 * line queue (same pattern as mcp_get, notes_list, etc.). A switch goes through
 * the same controller as `/model`, so the vision-gated tools follow it too.
 */
export async function handleModelMessage(
  ports: ModelPickerPorts,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const type = msg["type"];
  if (type === "model_list") {
    const result = await ports.details();
    if (!result.ok) return { type: "model_list", error: formatError(result.error) };
    return { type: "model_list", models: result.value, active: ports.controller.getModel() };
  }
  if (type === "model_set") {
    const model = String(msg["model"]);
    ports.controller.setModel(model);
    return { type: "model_set", ok: true, active: ports.controller.getModel() };
  }
  return {};
}
