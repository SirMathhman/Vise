import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { globalDataDir } from "../data-dir.ts";

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

const isStringMap = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === "string");

/** Validate one server entry; returns the spec, or the reason it was refused. */
export function parseServer(value: unknown): McpServerSpec | string {
  if (!isRecord(value)) return "must be an object";
  const { command, url } = value;
  if (url !== undefined) return parseUrlServer(value);
  if (typeof command !== "string" || command === "") {
    return "needs a non-empty 'command' (a local server) or a 'url' (a remote one)";
  }
  const args = value["args"] ?? [];
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) {
    return "'args' must be a list of strings";
  }
  const env = value["env"] ?? {};
  if (!isStringMap(env)) return "'env' must map names to strings";
  return { command, args: args as string[], env };
}

function parseUrlServer(value: Record<string, unknown>): UrlSpec | string {
  if (value["command"] !== undefined) return "use either 'command' or 'url', not both";
  const url = value["url"];
  let parsed: URL | undefined;
  try {
    parsed = typeof url === "string" ? new URL(url) : undefined;
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    return "'url' must be an http or https address";
  }
  const headers = value["headers"] ?? {};
  if (!isStringMap(headers)) return "'headers' must map names to strings";
  return { url: parsed.href, headers };
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
