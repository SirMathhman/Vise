import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  err,
  ok,
  type HttpServerEntry,
  type McpServerEntry,
  type McpServerStatus,
  type McpStore,
  type Result,
  type Scope,
  type ScopedMcpServer,
  type StdioServerEntry,
} from "../../core/messages.ts";

// The servers file, in the working directory. An entry is either a program started over stdio (command and
// args) or an endpoint reached over HTTP (url and optional headers).
export const MCP_FILE = join(".vise", "mcp.json");

// A server name becomes part of each tool name the model sees, so it may not contain "__".
const SERVER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
// A header name is a token: letters, digits, and hyphens. A value may not hold a line break.
const HEADER_NAME = /^[A-Za-z0-9-]+$/;
const LINE_BREAK = /[\r\n]/;

export type McpServerConfig = McpServerEntry;

interface ServerFields {
  command?: unknown;
  args?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface ServersFile {
  servers?: unknown;
}

// Reads the configured servers. A missing file configures none. A file that is not JSON, or an entry
// that is not valid, is an error that names the entry.
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
    const parsed = parseEntry(name, entry as ServerFields | null);
    if (!parsed.ok) return err(parsed.error);
    configs.push(parsed.value);
  }
  return ok(configs);
}

// One entry: an endpoint if it has a url, otherwise a program that needs a command.
function parseEntry(name: string, fields: ServerFields | null): Result<McpServerEntry> {
  if (fields?.url !== undefined) {
    if (fields.command !== undefined) return err(new Error(`server "${name}" has both a command and a url`));
    return parseHttp(name, fields);
  }
  if (typeof fields?.command !== "string" || fields.command === "") {
    return err(new Error(`server "${name}" needs a command or a url`));
  }
  const args = fields.args ?? [];
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    return err(new Error(`server "${name}" args must be a list of strings`));
  }
  const stdio: StdioServerEntry = { kind: "stdio", name, command: fields.command, args };
  return ok(stdio);
}

// An endpoint: an http or https URL, and headers whose names are tokens and whose values are one line.
function parseHttp(name: string, fields: ServerFields): Result<McpServerEntry> {
  if (typeof fields.url !== "string") return err(new Error(`server "${name}" url must be text`));
  let url: URL;
  try {
    url = new URL(fields.url);
  } catch {
    return err(new Error(`server "${name}" url is not a URL`));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return err(new Error(`server "${name}" url must be http or https`));
  }
  const headers = fields.headers ?? {};
  if (typeof headers !== "object" || headers === null || Array.isArray(headers)) {
    return err(new Error(`server "${name}" headers must be an object of text values`));
  }
  const values: Record<string, string> = {};
  for (const [header, value] of Object.entries(headers)) {
    if (!HEADER_NAME.test(header) || typeof value !== "string" || LINE_BREAK.test(value)) {
      return err(new Error(`server "${name}" has a header that is not valid: ${header}`));
    }
    values[header] = value;
  }
  const endpoint: HttpServerEntry = { kind: "http", name, url: fields.url, headers: values };
  return ok(endpoint);
}

// The entry as the file holds it.
function fileEntryOf(server: McpServerEntry): unknown {
  if (server.kind === "http") return { url: server.url, headers: server.headers };
  return { command: server.command, args: server.args };
}

// The page never receives header values, so it sends a blank one for a header it did not change. A blank value
// keeps the value the file holds for the same header of the same server. A new header with no value is refused.
function keepHeaderValues(servers: McpServerEntry[], stored: McpServerEntry[]): Result<McpServerEntry[]> {
  const kept: McpServerEntry[] = [];
  for (const server of servers) {
    if (server.kind !== "http") {
      kept.push(server);
      continue;
    }
    const previous = stored.find((entry) => entry.name === server.name && entry.kind === "http");
    const headers: Record<string, string> = {};
    for (const [header, value] of Object.entries(server.headers)) {
      const held = previous?.kind === "http" ? previous.headers[header] : undefined;
      if (value !== "") headers[header] = value;
      else if (held !== undefined) headers[header] = held;
      else return err(new Error(`server "${server.name}" needs a value for the header ${header}`));
    }
    kept.push({ ...server, headers });
  }
  return ok(kept);
}

// Writes the servers to the file, replacing it. The entries are checked the same way a read checks them,
// and two entries may not share a name, so the file is never written in a form the reader refuses.
export async function saveMcpConfig(root: string, servers: McpServerEntry[]): Promise<Result<void>> {
  const names = servers.map((server) => server.name);
  if (new Set(names).size !== names.length) return err(new Error("two servers have the same name"));
  const stored = await readMcpConfig(root);
  const kept = keepHeaderValues(servers, stored.ok ? stored.value : []);
  if (!kept.ok) return err(kept.error);
  const body: Record<string, unknown> = {};
  for (const server of kept.value) {
    body[server.name] = fileEntryOf(server);
  }
  const checked = parseServers({ servers: body });
  if (!checked.ok) return err(checked.error);
  try {
    await mkdir(join(root, ".vise"), { recursive: true });
    await writeFile(join(root, MCP_FILE), JSON.stringify({ servers: body }, null, 2) + "\n", "utf8");
    return ok(undefined);
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
}

// The store the session reads and saves the servers through. `running` is the list from startup, since
// a change to the file applies at the next start.
export function mcpStore(root: string, running: McpServerStatus[]): McpStore {
  return {
    running: () => running,
    config: () => readMcpConfig(root),
    save: (servers) => saveMcpConfig(root, servers),
  };
}

// Both files: the project folder's, and the home folder's. Each entry is tagged with the file it came from. Both
// lists are kept, so the editor can change either file.
export async function readScopedMcp(local: string, global: string): Promise<Result<ScopedMcpServer[]>> {
  const here = await readMcpConfig(local);
  if (!here.ok) return err(here.error);
  const there = await readMcpConfig(global);
  if (!there.ok) return err(there.error);
  return ok([...here.value.map(tagged("local")), ...there.value.map(tagged("global"))]);
}

function tagged(scope: Scope): (server: McpServerEntry) => ScopedMcpServer {
  return (server) => ({ ...server, scope });
}

// The servers that run: a project server replaces a home server with the same name.
export function effectiveServers(servers: ScopedMcpServer[]): McpServerEntry[] {
  const local = new Set(servers.filter((server) => server.scope === "local").map((server) => server.name));
  return servers
    .filter((server) => server.scope !== "global" || !local.has(server.name))
    .map(tagless);
}

// Writes each file with the servers that belong to it. A file that holds no server and is not there yet is not
// created, so a home folder with no servers gets no file. A server with no scope is refused.
export async function saveScopedMcp(local: string, global: string, servers: ScopedMcpServer[]): Promise<Result<void>> {
  if (servers.some((server) => server.scope === undefined)) return err(new Error("a server has no scope"));
  const pick = (scope: Scope) => servers.filter((server) => server.scope === scope).map(tagless);
  const there = pick("global");
  const stored = await readMcpConfig(global);
  if (!stored.ok) return err(stored.error);
  if (there.length > 0 || stored.value.length > 0) {
    const wrote = await saveMcpConfig(global, there);
    if (!wrote.ok) return err(wrote.error);
  }
  return saveMcpConfig(local, pick("local"));
}

function tagless(server: ScopedMcpServer): McpServerEntry {
  const entry: ScopedMcpServer = { ...server };
  delete entry.scope;
  return entry as McpServerEntry;
}

// The store for both files, read and saved as one list. `running` is the list from startup.
export function scopedMcpStore(local: string, global: string, running: McpServerStatus[]): McpStore {
  return {
    running: () => running,
    config: () => readScopedMcp(local, global),
    save: (servers) => saveScopedMcp(local, global, servers),
  };
}
