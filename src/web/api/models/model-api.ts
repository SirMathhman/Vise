import type { ModelPickerPorts } from "../../../wiring.ts";
import { formatError } from "../../../output/format.ts";
import { switchModel } from "../../../repl/commands/commands.ts";

/**
 * The model picker's messages, answered at once and never queued behind a turn:
 *   browser → server: { type: "model_list" }
 *                     { type: "model_set", model }
 *   server → browser: { type: "model_list", models, active }
 *                     { type: "model_list", error, active }
 *                     { type: "model_set", ok: true, active }
 *                     { type: "model_set", ok: false, error, active }
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
    if (!result.ok) {
      return { type: "model_list", error: formatError(result.error), active: ports.controller.getModel() };
    }
    return { type: "model_list", models: result.value, active: ports.controller.getModel() };
  }
  if (type === "model_set") {
    const model = msg["model"];
    const active = ports.controller.getModel();
    if (typeof model !== "string") {
      return { type: "model_set", ok: false, error: "no model given", active };
    }
    const switched = await switchModel(ports.controller, model);
    if (!switched.ok) {
      return { type: "model_set", ok: false, error: formatError(switched.error), active };
    }
    return { type: "model_set", ok: true, active: ports.controller.getModel() };
  }
  return {};
}
