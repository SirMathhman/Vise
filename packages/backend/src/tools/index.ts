import { LIST_DIRECTORY_TOOL, runListDirectory } from "../list-directory";
import { READ_FILE_TOOL, runReadFile } from "../read-file";

// A tool the model may call: its definition for the request, and what running it returns.
interface Tool {
  definition: { type: "function"; function: { name: string } };
  run: (argumentsJson: string) => Promise<string>;
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
]);

// The tool definitions sent with each request.
export const toolDefinitions = [...TOOLS.values()].map(
  (tool) => tool.definition,
);

// Runs a tool the model called. An unknown name is reported back to the model as text.
export async function runTool(
  name: string,
  argumentsJson: string,
): Promise<string> {
  const tool = TOOLS.get(name);
  return tool ? tool.run(argumentsJson) : `Unknown tool: ${name}`;
}
