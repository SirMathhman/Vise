import type { WorkflowEvent } from "../core/workflow.ts";
import { formatError } from "./format.ts";

/** How a workflow event is shown: one line, and whether it is progress, good news or a problem. */
export interface WorkflowLine {
  text: string;
  level: "info" | "ok" | "warn";
}

/** The line shown for a workflow event (undefined for the start, which the first step line follows at once). */
export function formatWorkflowEvent(event: WorkflowEvent): WorkflowLine | undefined {
  if (event.kind === "start") return undefined;
  if (event.kind === "profile") {
    const now = event.name ?? "no profile";
    const back = event.was === undefined ? "/profile with no name lists them" : `/profile ${event.was} goes back`;
    return {
      text: `workflow stopped early: staying in profile '${now}' so you can continue (you were in '${event.was ?? "none"}'; ${back})`,
      level: "info",
    };
  }
  if (event.kind === "step") {
    const label = event.label === "" ? "" : ` · ${event.label}`;
    return {
      text: `▸ workflow ${event.name} · step ${event.index}/${event.total}${label}`,
      level: "info",
    };
  }
  if (!event.error) {
    return { text: `✓ workflow ${event.name} finished`, level: "ok" };
  }
  const why = event.error.kind === "interrupted" ? "stopped" : "failed";
  return {
    text: `⚠ workflow ${event.name} ${why} at step ${event.step}/${event.total} — ${formatError(event.error)}`,
    level: "warn",
  };
}
