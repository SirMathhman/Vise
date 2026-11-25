import type { Approval } from "../chat/approvals";
import { CREATE_FILE_TOOL, runCreateFile } from "./create-file";
import { EDIT_FILE_TOOL, runEditFile } from "./edit-file";
import { LIST_DIRECTORY_TOOL, runListDirectory } from "./list-directory";
import { READ_FILE_TOOL, runReadFile } from "./read-file";
import { RUN_COMMAND_TOOL, runRunCommand } from "../shell/shell";

// A tool the model may call: its definition for the request, and what running it returns.
// A tool that changes files returns an Approval instead, and nothing changes until the user
// approves it. Every tool receives the project root from the caller.
// The name a tool is offered under.
interface ToolFunction {
  name: string;
}

// A tool as offered to the model in each request.
interface ToolDefinition {
  type: "function";
  function: ToolFunction;
}

interface Tool {
  definition: ToolDefinition;
  run(root: string, argumentsJson: string): Promise<string | Approval>;
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
]);

/**
 * The tool definitions sent with each request.
 */
export const toolDefinitions = [...TOOLS.values()].map(
  (tool) => tool.definition,
);

/**
 * Runs a tool the model called. An unknown name is reported back to the model as text.
 *
 * @param root The project root.
 * @param name The name of the tool the model called.
 * @param argumentsJson The model's arguments, as JSON text.
 * @returns The tool's result text, or an approval card for a change that needs the user.
 */
export async function runTool(
  root: string,
  name: string,
  argumentsJson: string,
): Promise<string | Approval> {
  const tool = TOOLS.get(name);
  return tool ? tool.run(root, argumentsJson) : `Unknown tool: ${name}`;
}
