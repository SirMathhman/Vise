import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalDataDir } from "../data-dir.ts";

/** How to start one MCP server over stdio. */
export interface McpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpConfig {
  servers: Record<string, McpServerSpec>;
  /** Entries that were skipped, each with the reason. */
  problems: string[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate one server entry; returns the spec, or the reason it was refused. */
export function parseServer(value: unknown): McpServerSpec | string {
  if (!isRecord(value)) return "must be an object";
  const command = value["command"];
  if (typeof command !== "string" || command === "") {
    return "needs a non-empty 'command' (only stdio servers are supported)";
  }
  const args = value["args"] ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return "'args' must be a list of strings";
  }
  const env = value["env"] ?? {};
  if (
    !isRecord(env) ||
    !Object.values(env).every((v) => typeof v === "string")
  ) {
    return "'env' must map names to strings";
  }
  return {
    command,
    args: args as string[],
    env: env as Record<string, string>,
  };
}

/** The `mcpServers` object of a JSON file, or why it could not be read (a missing file is just empty). */
function readServers(
  path: string,
  problems: string[],
): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const file: unknown = JSON.parse(readFileSync(path, "utf8"));
    const servers = isRecord(file) ? file["mcpServers"] : undefined;
    if (servers === undefined) return {};
    if (isRecord(servers)) return servers;
    problems.push(`${path}: 'mcpServers' must be an object`);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    problems.push(`${path}: ${reason}`);
  }
  return {};
}

/**
 * The MCP servers for a session rooted at `root`: the global `~/.vise/mcp.json`
 * overlaid by the project's `.viserc.json`, both keyed `mcpServers`. A project
 * entry replaces a global one of the same name; `"disabled": true` removes it.
 */
export function loadMcpServers(
  root: string,
  globalDir: string = globalDataDir,
): McpConfig {
  const problems: string[] = [];
  const merged: Record<string, unknown> = {
    ...readServers(join(globalDir, "mcp.json"), problems),
    ...readServers(join(root, ".viserc.json"), problems),
  };
  const servers: Record<string, McpServerSpec> = {};
  for (const [name, value] of Object.entries(merged)) {
    if (isRecord(value) && value["disabled"] === true) continue;
    const spec = parseServer(value);
    if (typeof spec === "string") problems.push(`MCP server "${name}": ${spec}`);
    else servers[name] = spec;
  }
  return { servers, problems };
}
