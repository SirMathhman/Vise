import { err, ok, type Result } from "../../core/messages.ts";
import { openSession, type McpSession } from "./client.ts";
import { readMcpConfig, type McpServerConfig } from "./config.ts";

// The protocol revision Vise speaks. A server that answers with another one may still work; the
// requests Vise makes are the same in every revision it names.
const PROTOCOL_VERSION = "2025-06-18";
// The name the model sees: `<server>__<tool>`, within the limit many providers set.
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
// Pages of tools/list read before the listing is cut short, so a server cannot loop forever.
const MAX_PAGES = 100;

// A tool as the request carries it. The shape matches the built-in specs.
export interface McpToolSpec {
  type: "function";
  function: McpFunction;
}

export interface McpFunction {
  name: string;
  description: string;
  parameters: unknown;
}

// The tools of every server that started, and the calls the model may make to them.
export interface McpRegistry {
  specs(): McpToolSpec[];
  // Why a server or one of its tools was left out, one line each.
  problems(): string[];
  has(name: string): boolean;
  call(name: string, argumentsText: string): Promise<string>;
  stop(): Promise<void>;
}

interface RemoteTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

interface LoadedTool {
  name: string;
  remoteName: string;
  session: McpSession;
  spec: McpToolSpec;
}

interface LoadedServer {
  session: McpSession;
  tools: LoadedTool[];
  problems: string[];
}

// The registry of a session with no servers: it has no tools and nothing to stop.
export function noServers(): McpRegistry {
  return registryOf([], [], []);
}

// Starts every configured server in the working directory. A server that fails is left out and
// named in `problems`; the others still run. Only a broken config file fails the whole call.
export async function startMcpServers(root: string): Promise<Result<McpRegistry>> {
  const configs = await readMcpConfig(root);
  if (!configs.ok) return err(configs.error);
  const tools: LoadedTool[] = [];
  const sessions: McpSession[] = [];
  const problems: string[] = [];
  for (const config of configs.value) {
    const loaded = await loadServer(root, config);
    if (!loaded.ok) {
      problems.push(`${config.name}: ${loaded.error.message}`);
      continue;
    }
    sessions.push(loaded.value.session);
    tools.push(...loaded.value.tools);
    problems.push(...loaded.value.problems.map((problem) => `${config.name}: ${problem}`));
  }
  return ok(registryOf(tools, sessions, problems));
}

function registryOf(
  tools: LoadedTool[],
  sessions: McpSession[],
  problems: string[],
): McpRegistry {
  return {
    specs: () => tools.map((tool) => tool.spec),
    problems: () => problems,
    has: (name) => tools.some((tool) => tool.name === name),
    call: async (name, argumentsText) => {
      const tool = tools.find((candidate) => candidate.name === name);
      if (tool === undefined) return `error: no server offers ${name}`;
      return callTool(tool, argumentsText);
    },
    stop: async () => {
      await Promise.all(sessions.map((session) => session.stop()));
    },
  };
}

// Starts one server, shakes hands, and lists its tools. On failure the server is stopped.
async function loadServer(
  root: string,
  config: McpServerConfig,
): Promise<Result<LoadedServer>> {
  const opened = openSession(config.command, config.args, root);
  if (!opened.ok) return err(opened.error);
  const session = opened.value;
  const handshake = await session.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "vise", version: "0.1.0" },
  });
  if (!handshake.ok) {
    await session.stop();
    return err(handshake.error);
  }
  session.notify("notifications/initialized", {});
  const listed = await listTools(session);
  if (!listed.ok) {
    await session.stop();
    return err(listed.error);
  }
  const tools: LoadedTool[] = [];
  const problems: string[] = [];
  for (const remote of listed.value) {
    const name = `${config.name}__${remote.name}`;
    if (!TOOL_NAME.test(name)) {
      problems.push(`tool ${remote.name} is left out: its name is not usable`);
    } else if (tools.some((tool) => tool.name === name)) {
      problems.push(`tool ${remote.name} is left out: its name is already used`);
    } else {
      tools.push(toLoadedTool(name, remote, session));
    }
  }
  return ok({ session, tools, problems });
}

function toLoadedTool(name: string, remote: RemoteTool, session: McpSession): LoadedTool {
  return {
    name,
    remoteName: remote.name,
    session,
    spec: {
      type: "function",
      function: {
        name,
        description: remote.description ?? "",
        parameters: remote.inputSchema ?? { type: "object", properties: {} },
      },
    },
  };
}

interface ListResult {
  tools?: unknown;
  nextCursor?: unknown;
}

// Reads every page of tools/list. A page that is not in the expected shape is an error.
async function listTools(session: McpSession): Promise<Result<RemoteTool[]>> {
  const all: RemoteTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const answer = await session.request("tools/list", cursor === undefined ? {} : { cursor });
    if (!answer.ok) return err(answer.error);
    const result = (answer.value ?? {}) as ListResult;
    if (!Array.isArray(result.tools) || !result.tools.every(isRemoteTool)) {
      return err(new Error("tools/list did not return a list of tools"));
    }
    all.push(...result.tools);
    if (typeof result.nextCursor !== "string") return ok(all);
    cursor = result.nextCursor;
  }
  return ok(all);
}

function isRemoteTool(value: unknown): value is RemoteTool {
  return typeof value === "object" && value !== null && typeof (value as RemoteTool).name === "string";
}

interface ContentPart {
  type?: unknown;
  text?: unknown;
}

interface CallResult {
  content?: unknown;
  isError?: unknown;
}

// Runs one call. The arguments are the model's JSON text, checked to be an object before the server sees them.
async function callTool(tool: LoadedTool, argumentsText: string): Promise<string> {
  const parsed = parseArguments(argumentsText);
  if (!parsed.ok) return `invalid arguments: ${parsed.error.message}`;
  const answer = await tool.session.request("tools/call", {
    name: tool.remoteName,
    arguments: parsed.value,
  });
  if (!answer.ok) return `error: ${answer.error.message}`;
  return resultText(answer.value as CallResult | undefined);
}

function parseArguments(text: string): Result<Record<string, unknown>> {
  let value: unknown;
  try {
    value = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return err(new Error("not JSON"));
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return err(new Error("expected a JSON object"));
  }
  return ok(value as Record<string, unknown>);
}

// The text of a result. Parts that are not text are named, not shown.
function resultText(result: CallResult | undefined): string {
  const parts = Array.isArray(result?.content) ? (result.content as ContentPart[]) : [];
  const text = parts
    .map((part) =>
      part.type === "text" && typeof part.text === "string"
        ? part.text
        : `[${typeof part.type === "string" ? part.type : "unknown"} content]`,
    )
    .join("\n");
  if (result?.isError === true) return `error: ${text || "the tool failed"}`;
  return text || "(no output)";
}
