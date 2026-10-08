import {
  deleteWorkflowAt,
  listWorkflows,
  readWorkflowAt,
  saveWorkflowAt,
} from "../../stores/workflows.ts";
import type { ViseError } from "../../core/errors.ts";
import { formatError } from "../../output/format.ts";

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

const list = (bases: WorkflowBases): Reply => ({
  type: "workflows",
  workflows: listWorkflows(bases.project, bases.global),
});

const why = (error: ViseError): string =>
  error.kind === "malformed" ? error.body : formatError(error);

const failed = (error: string): Reply[] => [
  { type: "workflow_result", ok: false, error },
];

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
  const scope = msg["scope"];
  if (scope !== "project" && scope !== "global") {
    return failed("scope must be 'project' or 'global'");
  }
  const name = str(msg["name"]).trim();
  const base = bases[scope];
  if (type === "workflow_get") {
    const read = readWorkflowAt(base, name);
    if (!read.ok) return failed(why(read.error));
    return [{ type: "workflow", name, scope, steps: read.value.steps }];
  }
  const done =
    type === "workflow_delete"
      ? deleteWorkflowAt(base, name)
      : saveWorkflowAt(base, name, msg["steps"], msg["replace"] === true);
  if (!done.ok) return failed(why(done.error));
  const deleted = type === "workflow_delete" ? { deleted: true } : {};
  return [
    { type: "workflow_result", ok: true, ...deleted, name, scope },
    list(bases),
  ];
}
