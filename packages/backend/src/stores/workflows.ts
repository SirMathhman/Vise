import { writeFileAtomic } from "./atomic-write.ts";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Result } from "@vise/core";
import { parse, parseJson, workflowSchema } from "@vise/core";
import { formatError } from "../output/format.ts";
import { validName } from "./notes.ts";
import type { Workflow, WorkflowScope } from "@vise/core";

export type { WorkflowScope } from "@vise/core";

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

export function listWorkflows(projectBase: string, globalBase: string): WorkflowEntry[] {
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
  writeFileSync(path, `${JSON.stringify(WORKFLOW_TEMPLATE, null, 2)}\n`, "utf8");
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
  const result = parseJson(workflowSchema, text.value);
  if (!result.ok) return fail(`workflow '${name}': ${(result.error as { body: string }).body.split("\n")[0]}`);
  return result;
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
  const workflow = parseWorkflowJson({ steps });
  if (!workflow.ok) return workflow;
  return tryIo("save", name, () => {
    writeFileAtomic(path, `${JSON.stringify(workflow.value, null, 2)}\n`);
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
  const result = parseJson(workflowSchema, text);
  if (!result.ok) throw new Error(formatError(result.error));
  return result.value;
}

function parseWorkflowJson(value: unknown): Result<Workflow> {
  const result = parse(workflowSchema, value);
  if (!result.ok) {
    return fail(`workflow: ${(result.error as { body: string }).body.split("\n")[0]}`);
  }
  return result;
}
