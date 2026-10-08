import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { validName } from "./notes.ts";
import type { Workflow, WorkflowScope, WorkflowStep } from "../core/workflow.ts";

export type { WorkflowScope } from "../core/workflow.ts";

export interface WorkflowEntry {
  name: string;
  scope: WorkflowScope;
  active: boolean;
}

const WORKFLOW_TEMPLATE: Workflow = {
  steps: [{ type: "instruction", text: "TODO: describe the required step" }],
};

function workflowPath(base: string, name: string): string {
  return join(base, "workflows", `${name}.json`);
}

export function listWorkflows(
  projectBase: string,
  globalBase: string,
): WorkflowEntry[] {
  const projectNames = namesAt(projectBase);
  const globalNames = namesAt(globalBase);
  return [
    ...projectNames.map((name) => ({
      name,
      scope: "project" as const,
      active: true,
    })),
    ...globalNames.map((name) => ({
      name,
      scope: "global" as const,
      active: !projectNames.includes(name),
    })),
  ];
}

export function loadWorkflow(
  projectBase: string,
  globalBase: string,
  name: string,
): Workflow | undefined {
  if (!validName(name)) return undefined;
  const projectPath = workflowPath(projectBase, name);
  const globalPath = workflowPath(globalBase, name);
  const path = existsSync(projectPath) ? projectPath : globalPath;
  if (!existsSync(path)) return undefined;
  return parseWorkflow(readFileSync(path, "utf8"));
}

export function initWorkflow(base: string, name: string): void {
  if (!validName(name)) throw new Error(`invalid workflow name '${name}'`);
  const path = workflowPath(base, name);
  if (existsSync(path)) throw new Error(`workflow '${name}' already exists`);
  mkdirSync(join(base, "workflows"), { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(WORKFLOW_TEMPLATE, null, 2)}\n`,
    "utf8",
  );
}

/** The workflow stored under exactly `base` (no project/global fallback), for the editor. */
export function readWorkflowAt(base: string, name: string): Workflow {
  const path = workflowPath(base, name);
  if (!validName(name) || !existsSync(path)) {
    throw new Error(`workflow '${name}' not found`);
  }
  return parseWorkflow(readFileSync(path, "utf8"));
}

/** Write a workflow from the editor; a new workflow may not replace an existing one. */
export function saveWorkflowAt(
  base: string,
  name: string,
  steps: unknown,
  replace: boolean,
): void {
  if (!validName(name)) throw new Error(`invalid workflow name '${name}'`);
  const path = workflowPath(base, name);
  if (!replace && existsSync(path)) {
    throw new Error(`workflow '${name}' already exists`);
  }
  const workflow = validateWorkflow({ steps });
  mkdirSync(join(base, "workflows"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(workflow, null, 2)}
`, "utf8");
}

export function deleteWorkflowAt(base: string, name: string): void {
  if (!validName(name) || !existsSync(workflowPath(base, name))) {
    throw new Error(`workflow '${name}' not found`);
  }
  unlinkSync(workflowPath(base, name));
}

function namesAt(base: string): string[] {
  const dir = join(base, "workflows");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -5))
    .sort();
}

function parseWorkflow(text: string): Workflow {
  return validateWorkflow(JSON.parse(text));
}

function validateWorkflow(value: unknown): Workflow {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { steps?: unknown }).steps)
  ) {
    throw new Error("workflow must be a JSON object with a steps array");
  }
  const steps = (value as { steps: unknown[] }).steps.map(validateStep);
  return { steps };
}

function validateStep(value: unknown): WorkflowStep {
  if (typeof value !== "object" || value === null) {
    throw new Error("workflow step must be an object");
  }
  const step = value as Record<string, unknown>;
  if (
    step.type === "instruction" &&
    typeof step.text === "string" &&
    step.text.trim() !== ""
  ) {
    return { type: "instruction", text: step.text };
  }
  if (
    step.type === "tool" &&
    typeof step.name === "string" &&
    step.name.trim() !== "" &&
    typeof step.args === "object" &&
    step.args !== null &&
    !Array.isArray(step.args)
  ) {
    return {
      type: "tool",
      name: step.name,
      args: step.args as Record<string, unknown>,
    };
  }
  throw new Error(
    "workflow step must be an instruction with non-empty text or a tool with a name and args object",
  );
}
