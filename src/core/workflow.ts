import type { Client, Tool, ToolRunner, TurnCallbacks } from "./engine.ts";
import { runTurn } from "./engine.ts";
import type { Message, Result } from "./errors.ts";

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
  callbacks: TurnCallbacks;
}

/** Execute workflow steps in order, then ask the model for a final response. */
export async function runWorkflow(
  options: WorkflowRunOptions,
): Promise<Result<string>> {
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
    workflowCallbacks(options),
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
    workflowCallbacks(options),
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
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `tool '${step.name}' has no object argument schema`,
      },
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
  const generated = await (options.client.as?.("workflow") ?? options.client).chat(
    options.messages,
    undefined,
    undefined,
    options.callbacks.onThinking,
    options.callbacks.onPromptProgress,
    { type: "object", ...schema },
    options.callbacks.abort,
  );
  if (!generated.ok) return generated;
  const args = parseAndValidateArguments(
    generated.value.content,
    step.name,
    schema,
  );
  if (!args.ok) return args;

  options.messages.push({
    role: "assistant",
    content: generated.value.content,
  });
  options.callbacks.onToolCall?.(step.name, 0, args.value);
  const run = options.tools.run.bind(options.tools);
  let output: string;
  try {
    output = await run(step.name, args.value, options.callbacks.abort);
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

function parseAndValidateArguments(
  content: string,
  toolName: string,
  schema: Record<string, unknown>,
): Result<Record<string, unknown>> {
  const args = parseArguments(content, toolName);
  if (!args.ok) return args;
  const validationError = validateArguments(args.value, schema);
  if (validationError) {
    return {
      ok: false,
      error: {
        kind: "malformed",
        body: `workflow generated invalid arguments for '${toolName}': ${validationError}`,
      },
    };
  }
  return args;
}

function parseArguments(
  content: string,
  toolName: string,
): Result<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(content);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
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

function workflowCallbacks(options: WorkflowRunOptions): TurnCallbacks {
  return options.callbacks;
}

function validateArguments(
  args: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | undefined {
  const properties = schema.properties;
  if (
    typeof properties !== "object" ||
    properties === null ||
    Array.isArray(properties)
  ) {
    return "tool schema properties must be an object";
  }
  const propertySchemas = properties as Record<string, unknown>;
  const required = Array.isArray(schema.required)
    ? schema.required.filter(
        (entry): entry is string => typeof entry === "string",
      )
    : [];
  for (const key of required) {
    if (!(key in args)) return `missing required argument '${key}'`;
  }
  for (const [key, value] of Object.entries(args)) {
    if (!(key in propertySchemas)) return `unknown argument '${key}'`;
    const definition = propertySchemas[key];
    if (
      typeof definition !== "object" ||
      definition === null ||
      Array.isArray(definition)
    ) {
      return `invalid schema for argument '${key}'`;
    }
    const error = validateValue(
      value,
      definition as Record<string, unknown>,
      key,
    );
    if (error) return error;
  }
  return undefined;
}

function validateValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
): string | undefined {
  const type = schema.type;
  const valid =
    type === "string"
      ? typeof value === "string"
      : type === "integer"
        ? typeof value === "number" && Number.isInteger(value)
        : type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : type === "boolean"
            ? typeof value === "boolean"
            : type === "array"
              ? Array.isArray(value)
              : type === "object"
                ? typeof value === "object" &&
                  value !== null &&
                  !Array.isArray(value)
                : true;
  if (!valid) return `argument '${path}' must be ${String(type)}`;
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    return `argument '${path}' must be one of the allowed values`;
  }
  if (
    type === "array" &&
    Array.isArray(value) &&
    typeof schema.items === "object" &&
    schema.items !== null
  ) {
    const itemSchema = schema.items as Record<string, unknown>;
    for (const [index, item] of value.entries()) {
      const error = validateValue(item, itemSchema, `${path}[${index}]`);
      if (error) return error;
    }
  }
  if (
    type === "object" &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  ) {
    const nested = schema.properties;
    if (
      typeof nested === "object" &&
      nested !== null &&
      !Array.isArray(nested)
    ) {
      return validateArguments(value as Record<string, unknown>, {
        properties: nested,
        required: schema.required,
      });
    }
  }
  return undefined;
}
