import type { Client, Tool, ToolRunner } from "./engine.ts";
import { runTurn } from "./engine.ts";
import type { Message, PromptProgress, Result } from "./errors.ts";

export type WorkflowStep =
  | { type: "instruction"; text: string }
  | { type: "tool"; name: string; args: Record<string, unknown> };

export interface Workflow {
  steps: WorkflowStep[];
}

export type WorkflowScope = "project" | "global";

interface WorkflowRunOptions {
  client: Client;
  tools: ToolRunner;
  toolDefs: Tool[];
  messages: Message[];
  name: string;
  workflow: Workflow;
  request: string;
  onToken?: (token: string) => void;
  onThinking?: (token: string) => void;
  onPromptProgress?: (progress: PromptProgress) => void;
  onMaxRounds?: () => Promise<boolean>;
}

/** Execute workflow steps in order, then ask the model for a final response. */
export async function runWorkflow(options: WorkflowRunOptions): Promise<Result<string>> {
  const { messages, name, workflow, request } = options;
  messages.push({
    role: "user",
    content: `Run workflow '${name}'. User request: ${request || "(none)"}`,
  });

  for (const [index, step] of workflow.steps.entries()) {
    if (step.type === "instruction") {
      const result = await runInstructionStep(options, index + 1, step.text);
      if (!result.ok) return result;
      continue;
    }

    const result = await runToolStep(options, index + 1, step);
    if (!result.ok) return result;
  }

  messages.push({
    role: "user",
    content: `All steps in workflow '${name}' are complete. Respond to the user's request: ${request || "(none)"}`,
  });
  return runTurn(
    options.client,
    options.tools,
    messages,
    options.toolDefs,
    options.onToken,
    options.onThinking,
    options.onPromptProgress,
    options.onMaxRounds,
  );
}

async function runInstructionStep(
  options: WorkflowRunOptions,
  number: number,
  text: string,
): Promise<Result<string>> {
  options.messages.push({
    role: "user",
    content: `Workflow instruction step ${number}:\n${text}`,
  });
  return runTurn(
    options.client,
    options.tools,
    options.messages,
    options.toolDefs,
    options.onToken,
    options.onThinking,
    options.onPromptProgress,
    options.onMaxRounds,
  );
}

async function runToolStep(
  options: WorkflowRunOptions,
  number: number,
  step: Extract<WorkflowStep, { type: "tool" }>,
): Promise<Result<void>> {
  const tool = options.toolDefs.find(
    (definition) => definition.function.name === step.name,
  );
  if (!tool) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `workflow references unknown tool '${step.name}'`,
      },
    };
  }
  const properties = tool.function.parameters.properties;
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return {
      ok: false,
      error: { kind: "malformed", body: `tool '${step.name}' has no object argument schema` },
    };
  }
  const unsupported = Object.keys(step.args).find(
    (key) => !(key in properties),
  );
  if (unsupported) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `workflow argument template for '${step.name}' contains unknown argument '${unsupported}'`,
      },
    };
  }
  const schema = withRequiredPlaceholders(
    tool.function.parameters,
    Object.keys(step.args),
  );
  options.messages.push({
    role: "user",
    content: [
      `Workflow tool step ${number}: generate arguments for '${step.name}'.`,
      `User request: ${options.request || "(none)"}`,
      `Argument template: ${JSON.stringify(step.args)}`,
      "Use prior workflow messages and outputs when deciding argument values. Return only a JSON object matching this schema:",
      JSON.stringify(schema),
    ].join("\n"),
  });
  const generated = await options.client.chat(
    options.messages,
    undefined,
    undefined,
    options.onThinking,
    options.onPromptProgress,
    { type: "object", ...schema },
  );
  if (!generated.ok) return generated;
  const args = parseArguments(generated.value.content, step.name);
  if (!args.ok) return args;

  options.messages.push({
    role: "assistant",
    content: generated.value.content,
  });
  let output: string;
  try {
    output = await options.tools.run(step.name, args.value);
  } catch (error) {
    output = `error: ${error instanceof Error ? error.message : String(error)}`;
  }
  options.messages.push({
    role: "user",
    content: `Workflow tool step ${number} result from '${step.name}':\n${output}`,
  });
  if (output.trimStart().startsWith("error:")) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `workflow tool '${step.name}' failed: ${output}`,
      },
    };
  }
  return { ok: true, value: undefined };
}

function parseArguments(
  content: string,
  toolName: string,
): Result<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("expected an object");
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `workflow could not generate arguments for '${toolName}': ${reason}`,
      },
    };
  }
}

function withRequiredPlaceholders(
  source: Record<string, unknown>,
  placeholders: string[],
): Record<string, unknown> {
  const schema = { ...source };
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  schema.required = [...new Set([...required, ...placeholders])];
  return schema;
}
