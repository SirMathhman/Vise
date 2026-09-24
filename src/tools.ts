import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import type { ToolCall, ToolResponse } from "./types";

export const DEFAULT_LIST_LIMIT = 200;

const LIST_FILES_TOOL = {
  type: "function",
  function: {
    name: "list_files",
    description: "List the file and directory entries in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The directory to list. Defaults to the current working directory.",
        },
        limit: {
          type: "integer",
          description:
            "Maximum number of entries to return. Defaults to 200.",
        },
      },
      required: [] as string[],
    },
  },
};

export const tools = [LIST_FILES_TOOL];

export async function executeToolCall(call: ToolCall): Promise<ToolResponse> {
  if (call.function.name === "list_files") {
    const raw: unknown = call.function.arguments;
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const path =
      typeof args["path"] === "string" && args["path"] !== ""
        ? args["path"]
        : process.cwd();
    const rawLimit = args["limit"];
    const limit =
      typeof rawLimit === "number" && rawLimit > 0
        ? Math.floor(rawLimit)
        : DEFAULT_LIST_LIMIT;
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const sorted = [...entries].sort((a: Dirent, b: Dirent) =>
        a.name.localeCompare(b.name),
      );
      const total = sorted.length;
      const items = sorted.slice(0, limit).map((entry: Dirent) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
      const result = {
        total,
        truncated: total > limit,
        entries: items,
      };
      return { content: JSON.stringify(result, null, 2) };
    } catch (err) {
      return {
        content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { content: `Unknown tool: ${call.function.name}` };
}
