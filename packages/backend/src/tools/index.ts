import type { Approval } from "../chat/approvals";
import { CREATE_FILE_TOOL, runCreateFile } from "./create-file";
import { EDIT_FILE_TOOL, runEditFile } from "./edit-file";
import { LIST_DIRECTORY_TOOL, runListDirectory } from "./list-directory";
import { MODEL_INFO_TOOL, runModelInfo } from "./model-info";
import type { ModelSelf } from "../chat/model-facts";
import type { ReplyContext, SubagentRunner } from "../chat/reply-context";
import type { Result, ToolSummary } from "common";
import { ok } from "common";
import { readToolSettings } from "./tool-settings";
import {
  START_SUBAGENT_NAME,
  START_SUBAGENT_TOOL,
  runStartSubagent,
} from "./subagent";
import { READ_FILE_TOOL, runReadFile } from "./read-file";
import { RUN_COMMAND_TOOL, runRunCommand } from "../shell/shell";
import {
  CHECK_COMMAND_NAME,
  CHECK_COMMAND_TOOL,
  runCheckCommand,
} from "../shell/check-command";
import {
  DELETE_NOTE_NAME,
  DELETE_NOTE_TOOL,
  LIST_NOTES_NAME,
  LIST_NOTES_TOOL,
  READ_NOTE_NAME,
  READ_NOTE_TOOL,
  SAVE_NOTE_NAME,
  SAVE_NOTE_TOOL,
  runDeleteNote,
  runListNotes,
  runReadNote,
  runSaveNote,
} from "../notes/notes-tools";

// A tool the model may call: its definition for the request, and what running it returns.
// A tool that changes files returns an Approval instead, and nothing changes until the user
// approves it. Every tool receives the project root from the caller.
// The name a tool is offered under.
interface ToolFunction {
  name: string;
  description: string;
}

// A tool as offered to the model in each request.
interface ToolDefinition {
  type: "function";
  function: ToolFunction;
}

interface Tool {
  definition: ToolDefinition;
  run(
    root: string,
    argumentsJson: string,
    self?: ModelSelf,
    subagent?: SubagentRunner,
  ): Promise<string | Approval>;
}

// A tool that reads only its arguments. Every tool is called with the project root first, so
// this drops it.
function fromArguments(
  run: (argumentsJson: string) => Promise<string | Approval>,
): Tool["run"] {
  return (_root, argumentsJson) => run(argumentsJson);
}

// Every tool the backend offers, keyed by name.
const TOOLS = new Map<string, Tool>([
  [
    LIST_DIRECTORY_TOOL.function.name,
    { definition: LIST_DIRECTORY_TOOL, run: runListDirectory },
  ],
  [
    READ_FILE_TOOL.function.name,
    { definition: READ_FILE_TOOL, run: runReadFile },
  ],
  [
    EDIT_FILE_TOOL.function.name,
    { definition: EDIT_FILE_TOOL, run: runEditFile },
  ],
  [
    CREATE_FILE_TOOL.function.name,
    { definition: CREATE_FILE_TOOL, run: runCreateFile },
  ],
  [
    RUN_COMMAND_TOOL.function.name,
    { definition: RUN_COMMAND_TOOL, run: runRunCommand },
  ],
  [
    CHECK_COMMAND_NAME,
    { definition: CHECK_COMMAND_TOOL, run: fromArguments(runCheckCommand) },
  ],
  [
    MODEL_INFO_TOOL.function.name,
    { definition: MODEL_INFO_TOOL, run: runModelInfo },
  ],
  [
    START_SUBAGENT_NAME,
    { definition: START_SUBAGENT_TOOL, run: runStartSubagent },
  ],
  [LIST_NOTES_NAME, { definition: LIST_NOTES_TOOL, run: runListNotes }],
  [
    READ_NOTE_NAME,
    { definition: READ_NOTE_TOOL, run: fromArguments(runReadNote) },
  ],
  [
    SAVE_NOTE_NAME,
    { definition: SAVE_NOTE_TOOL, run: fromArguments(runSaveNote) },
  ],
  [
    DELETE_NOTE_NAME,
    { definition: DELETE_NOTE_TOOL, run: fromArguments(runDeleteNote) },
  ],
]);

/**
 * Whether a tool with this name exists.
 *
 * @param name The tool's name.
 * @returns True when the registry has a tool by that name.
 */
export function isToolName(name: string): boolean {
  return TOOLS.has(name);
}

/**
 * The tools the model may be offered: every tool the user has not turned off.
 *
 * @returns The enabled tool definitions, or a message when the settings cannot be read.
 */
export async function enabledToolDefinitions(): Promise<
  Result<typeof toolDefinitions, string>
> {
  const settings = await readToolSettings();
  if (!settings.ok) {
    return settings;
  }
  return ok(
    toolDefinitions.filter(
      (tool) => !settings.value.disabled.includes(tool.function.name),
    ),
  );
}

/**
 * The tools the model may call, with the description it reads for each.
 *
 * @returns One name and description per tool.
 */
export function listTools(): ToolSummary[] {
  return toolDefinitions.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
  }));
}

/**
 * The tool definitions sent with each request.
 */
export const toolDefinitions = [...TOOLS.values()].map(
  (tool) => tool.definition,
);

/**
 * Runs a tool the model called. An unknown name is reported back to the model as text.
 *
 * @param context What the reply passes to its tools: the project root and the model's facts.
 * @param name The name of the tool the model called.
 * @param argumentsJson The model's arguments, as JSON text.
 * @returns The tool's result text, or an approval card for a change that needs the user.
 */
export async function runTool(
  context: ReplyContext,
  name: string,
  argumentsJson: string,
): Promise<string | Approval> {
  const tool = TOOLS.get(name);
  return tool
    ? tool.run(context.root, argumentsJson, context.self, context.subagent)
    : `Unknown tool: ${name}`;
}
