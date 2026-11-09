import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "../../core/messages.ts";

// The servers file, in the working directory. Each entry starts one local program over stdio.
export const MCP_FILE = join(".vise", "mcp.json");

// A server name becomes part of each tool name the model sees, so it may not contain "__".
const SERVER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
}

interface ServerFields {
  command?: unknown;
  args?: unknown;
}

interface ServersFile {
  servers?: unknown;
}

// Reads the configured servers. A missing file configures none. A file that is not JSON, or an entry
// with a bad name, command, or argument list, is an error that names the entry.
export async function readMcpConfig(root: string): Promise<Result<McpServerConfig[]>> {
  let text: string;
  try {
    text = await readFile(join(root, MCP_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ok([]);
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error(`${MCP_FILE} is not JSON`));
  }
  return parseServers(value);
}

// Checks the shape of the file and each entry.
export function parseServers(value: unknown): Result<McpServerConfig[]> {
  const servers = (value as ServersFile | null)?.servers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return err(new Error(`${MCP_FILE} needs a "servers" object`));
  }
  const configs: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!SERVER_NAME.test(name)) {
      return err(new Error(`server name "${name}" must be lower-case letters, digits, and single hyphens`));
    }
    const fields = entry as ServerFields | null;
    if (typeof fields?.command !== "string" || fields.command === "") {
      return err(new Error(`server "${name}" needs a command`));
    }
    const args = fields.args ?? [];
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
      return err(new Error(`server "${name}" args must be a list of strings`));
    }
    configs.push({ name, command: fields.command, args });
  }
  return ok(configs);
}
