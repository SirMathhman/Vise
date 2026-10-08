import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Result } from "../core/errors.ts";
import { formatError } from "../output/format.ts";
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

const fail = <T>(body: string): Result<T> => ({
  ok: false,
  error: { kind: "malformed", body },
});

/** Run a file step, turning a thrown I/O error into a failed `Result`. */
function tryIo<T>(op: string, name: string, run: () => T): Result<T> {
  try {
    return { ok: true, value: run() };
  } catch (e) {
    return fail(`could not ${op} workflow '${name}': ${String(e)}`);
  }
}

/** The workflow stored under exactly `base` (no project/global fallback), for the editor. */
export function readWorkflowAt(base: string, name: string): Result<Workflow> {
  const path = workflowPath(base, name);
  if (!validName(name) || !existsSync(path)) {
    return fail(`workflow '${name}' not found`);
  }
  const text = tryIo("read", name, () => readFileSync(path, "utf8"));
  if (!text.ok) return text;
  try {
    return validateWorkflow(JSON.parse(text.value));
  } catch (e) {
    return fail(`workflow '${name}' is not valid JSON: ${String(e)}`);
  }
}

/** Write a workflow from the editor; a new workflow may not replace an existing one. */
export function saveWorkflowAt(
  base: string,
  name: string,
  steps: unknown,
  replace: boolean,
): Result<string> {
  if (!validName(name)) return fail(`invalid workflow name '${name}'`);
  const path = workflowPath(base, name);
  if (!replace && existsSync(path)) {
    return fail(`workflow '${name}' already exists`);
  }
  const workflow = validateWorkflow({ steps });
  if (!workflow.ok) return workflow;
  return tryIo("save", name, () => {
    mkdirSync(join(base, "workflows"), { recursive: true });
    const temp = `${path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(workflow.value, null, 2)}\n`, "utf8");
    renameSync(temp, path); // never leaves a half-written workflow
    return name;
  });
}

export function deleteWorkflowAt(base: string, name: string): Result<string> {
  const path = workflowPath(base, name);
  if (!validName(name) || !existsSync(path)) {
    return fail(`workflow '${name}' not found`);
  }
  return tryIo("delete", name, () => {
    unlinkSync(path);
    return name;
  });
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
  const result = validateWorkflow(JSON.parse(text));
  if (!result.ok) throw new Error(formatError(result.error));
  return result.value;
}

function validateWorkflow(value: unknown): Result<Workflow> {
  if (
    typeof value !== "object" ||
    value === null ||
    !Array.isArray((value as { steps?: unknown }).steps)
  ) {
    return fail("workflow must be a JSON object with a steps array");
  }
  const steps: WorkflowStep[] = [];
  for (const raw of (value as { steps: unknown[] }).steps) {
    const step = validateStep(raw);
    if (!step) {
      return fail(
        "workflow step must be an instruction with non-empty text, a profile with a name, or a tool with a name and args object",
      );
    }
    steps.push(step);
  }
  return { ok: true, value: { steps } };
}

function validateStep(value: unknown): WorkflowStep | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const step = value as Record<string, unknown>;
  if (
    step.type === "instruction" &&
    typeof step.text === "string" &&
    step.text.trim() !== ""
  ) {
    return { type: "instruction", text: step.text };
  }
  if (
    step.type === "profile" &&
    typeof step.name === "string" &&
    step.name.trim() !== ""
  ) {
    return { type: "profile", name: step.name };
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
      ...(step.exact === true ? { exact: true } : {}),
    };
  }
  return undefined;
}
