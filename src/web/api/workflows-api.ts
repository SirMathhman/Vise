import {
  deleteWorkflowAt,
  listWorkflows,
  readWorkflowAt,
  saveWorkflowAt,
} from "../../stores/workflows.ts";
import type { WorkflowScope } from "../../core/workflow.ts";

/**
 * The web UI's workflow editor. It reads and writes the same JSON files as
 * `/workflow` (`.vise/workflows/` of the project, `~/.vise/workflows/` global),
 * directly (never through a model turn).
 * Wire protocol (JSON):
 *   browser → server: { type:"workflows_list" }
 *                     { type:"workflow_get", name, scope }
 *                     { type:"workflow_save", name, scope, steps, replace? }   `replace` only when editing an existing one
 *                     { type:"workflow_delete", name, scope }
 *   server → browser: { type:"workflows", workflows:[{ name, scope, active }] }
 *                     { type:"workflow", name, scope, steps }
 *                     { type:"workflow_result", ok, deleted?, error?, name?, scope? }   after a save or delete
 */

type Reply = Record<string, unknown>;

/** The two data directories a workflow can live in. */
export interface WorkflowBases {
  project: string;
  global: string;
}

const str = (value: unknown): string =>
  typeof value === "string" ? value : "";

function scopeOf(value: unknown): WorkflowScope {
  if (value === "project" || value === "global") return value;
  throw new Error("scope must be 'project' or 'global'");
}

const list = (bases: WorkflowBases): Reply => ({
  type: "workflows",
  workflows: listWorkflows(bases.project, bases.global),
});

/** Handle one workflow message; null when `msg` is not a workflow message. */
export function handleWorkflowMessage(
  bases: WorkflowBases,
  msg: Record<string, unknown>,
): Reply[] | null {
  const type = msg["type"];
  if (type === "workflows_list") return [list(bases)];
  if (
    type !== "workflow_get" &&
    type !== "workflow_save" &&
    type !== "workflow_delete"
  ) {
    return null;
  }
  try {
    const scope = scopeOf(msg["scope"]);
    const name = str(msg["name"]).trim();
    const base = bases[scope];
    if (type === "workflow_get") {
      const { steps } = readWorkflowAt(base, name);
      return [{ type: "workflow", name, scope, steps }];
    }
    if (type === "workflow_delete") {
      deleteWorkflowAt(base, name);
      return [
        { type: "workflow_result", ok: true, deleted: true, name, scope },
        list(bases),
      ];
    }
    saveWorkflowAt(base, name, msg["steps"], msg["replace"] === true);
    return [{ type: "workflow_result", ok: true, name, scope }, list(bases)];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return [{ type: "workflow_result", ok: false, error: message }];
  }
}
