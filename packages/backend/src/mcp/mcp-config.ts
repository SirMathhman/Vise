import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalDataDir } from "../data-dir.ts";
import { parse, mcpServerSpecSchema } from "@vise/core";

/** A server started as a local process and spoken to over stdio. */
export interface StdioSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  url?: undefined;
}

/** A server reached at an http(s) URL (Streamable HTTP, or the older SSE transport); `headers` carry any credentials. */
export interface UrlSpec {
  url: string;
  headers: Record<string, string>;
  command?: undefined;
}

export type McpServerSpec = StdioSpec | UrlSpec;

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
  if (value["command"] !== undefined && value["url"] !== undefined) {
    return "use either 'command' or 'url', not both";
  }
  const result = parse(mcpServerSpecSchema, value);
  if (!result.ok) {
    // Extract the first issue line for a concise message
    const firstLine = (result.error as { body: string }).body.split("\n")[0] ?? "invalid";
    return firstLine.replace(/^[\w.]+: /, "");
  }
  return result.value as McpServerSpec;
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
