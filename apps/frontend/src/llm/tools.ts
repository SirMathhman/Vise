/**
 * Registry of the tools the LLM panel exposes to the model. Each entry pairs
 * the OpenAI tool definition (sent with every request) with its executor (run
 * in the browser through the sandboxed `/api` wrappers). Adding a tool means
 * adding one entry here — the panel maps over this list for both the tool
 * definitions and the dispatch, so it never hardcodes tool names.
 */
import { type LlmTool, type LlmToolCall, listDir } from "../api/client.js";

/** A runnable tool: the OpenAI definition paired with its executor. */
export interface LlmToolDef {
  definition: LlmTool;
  /** Run the tool and return a text result the model can read (errors included). */
  run: (args: Record<string, unknown>) => Promise<string>;
}

/** List the contents of a directory in the workspace (root-scoped via /api/ls). */
const listDirectory: LlmToolDef = {
  definition: {
    type: "function",
    function: {
      name: "list_directory",
      description:
        'List the files and subdirectories in a directory. Use this to answer questions about what files or folders exist. The path is relative to the workspace root; use an empty string ("") for the root.',
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Directory path relative to the workspace root. Use "" for the root.',
          },
        },
        required: ["path"],
      },
    },
  },
  run: async (args) => {
    const path = typeof args.path === "string" ? args.path : "";
    const data = await listDir(path);
    const lines = data.items.map((item) =>
      item.kind === "directory"
        ? `  [dir]  ${item.name}`
        : `  [file] ${item.name}`
    );
    return `Directory "${data.path}" contains:\n${lines.join("\n")}`;
  },
};

/** All tools available to the model, in a stable order. */
export const llmTools: LlmToolDef[] = [listDirectory];

/** The OpenAI tool definitions to send with each chat request. */
export const llmToolDefinitions: LlmTool[] = llmTools.map((t) => t.definition);

/**
 * Execute a single tool call by name and return a model-readable string.
 * Unknown tools and thrown errors are returned as text so the model can read
 * the problem and adapt, rather than the tool loop crashing.
 */
export async function executeLlmTool(tc: LlmToolCall): Promise<string> {
  const tool = llmTools.find(
    (t) => t.definition.function.name === tc.function.name
  );
  if (!tool) return `Error: unknown tool "${tc.function.name}".`;
  try {
    const args = JSON.parse(tc.function.arguments || "{}") as Record<
      string,
      unknown
    >;
    return await tool.run(args);
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : e}`;
  }
}
