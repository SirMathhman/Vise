import type { ApprovalAnswer } from "../../core/commands.ts";
import { HOOK_POINTS, type HookPoint, type ProfileDetail, type ProfileHook } from "../../core/notes.ts";
import { err, ok, type Result } from "../../core/messages.ts";
import type { ClientMessage, McpServerEntry, ProviderInput, Scope, ScopedMcpServer } from "../../protocol/protocol.ts";

const ANSWERS: string[] = ["approve", "refuse", "exit"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Reads one MCP server sent by the page: a program (kind stdio) or an endpoint (kind http), and the file it belongs
// to when the page names one. The store checks the names and the values before it writes.
function serverOf(value: unknown): ScopedMcpServer | undefined {
  const entry = entryOf(value);
  if (entry === undefined || !isRecord(value)) return undefined;
  const scope = scopeOf(value.scope);
  return scope === undefined ? entry : { ...entry, scope };
}

function entryOf(value: unknown): McpServerEntry | undefined {
  if (!isRecord(value) || typeof value.name !== "string") return undefined;
  if (value.kind === "http") {
    const { url, headers } = value;
    if (typeof url !== "string" || !isRecord(headers)) return undefined;
    const values: Record<string, string> = {};
    for (const [header, text] of Object.entries(headers)) {
      if (typeof text !== "string") return undefined;
      values[header] = text;
    }
    return { kind: "http", name: value.name, url, headers: values };
  }
  const { command, args } = value;
  if (value.kind !== "stdio" || typeof command !== "string") return undefined;
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) return undefined;
  return { kind: "stdio", name: value.name, command, args: args as string[] };
}

// The file a page item belongs to: the project's, or the home folder's.
function scopeOf(value: unknown): Scope | undefined {
  return value === "local" || value === "global" ? value : undefined;
}

// Reads a profile sent by the page. Each field is checked for its type and each hook point must exist;
// the store checks the rest (names, one-line commands) before it writes.
function profileOf(value: unknown): ProfileDetail | undefined {
  if (!isRecord(value)) return undefined;
  const { name, summary, text, tools, hooks } = value;
  if (typeof name !== "string" || typeof summary !== "string" || typeof text !== "string") return undefined;
  if (tools !== undefined && (!Array.isArray(tools) || !tools.every((tool) => typeof tool === "string"))) return undefined;
  if (!Array.isArray(hooks)) return undefined;
  const parsed: ProfileHook[] = [];
  for (const hook of hooks) {
    if (!isRecord(hook) || typeof hook.point !== "string" || typeof hook.command !== "string") return undefined;
    if (!(HOOK_POINTS as readonly string[]).includes(hook.point)) return undefined;
    parsed.push({ point: hook.point as HookPoint, command: hook.command });
  }
  const profile: ProfileDetail = { name, summary, text, hooks: parsed };
  if (tools !== undefined) profile.tools = tools as string[];
  return profile;
}

// Reads one llama.cpp server sent by the page: a name, a URL, and the key (blank keeps the saved one).
function providerOf(value: unknown): ProviderInput | undefined {
  if (!isRecord(value)) return undefined;
  const { kind, name, url, apiKey } = value;
  if (kind !== "openrouter" && kind !== "llama.cpp") return undefined;
  const scope = scopeOf(value.scope);
  if (typeof name !== "string" || typeof url !== "string" || typeof apiKey !== "string" || scope === undefined) {
    return undefined;
  }
  return { kind, name, url, apiKey, scope };
}

// Reads a message sent by the browser. The browser may send lines, approvals, and the two profile requests.
// Ending the input and failures come from the terminal, so a closed tab never ends the session.
export function parseClientMessage(text: string): Result<ClientMessage> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return err(new Error("the message is not JSON"));
  }
  if (!isRecord(value)) return err(new Error("the message is not an object"));
  if (value.kind === "line" && typeof value.text === "string") {
    const shown = value.shown;
    if (shown === undefined) return ok({ kind: "line", text: value.text });
    if (typeof shown !== "number") return err(new Error("shown is not a number"));
    return ok({ kind: "line", text: value.text, shown });
  }
  if (
    value.kind === "approval" &&
    typeof value.id === "number" &&
    typeof value.answer === "string" &&
    ANSWERS.includes(value.answer)
  ) {
    return ok({
      kind: "approval",
      id: value.id,
      answer: value.answer as ApprovalAnswer,
    });
  }
  if (value.kind === "profileRead" && typeof value.name === "string") {
    return ok({ kind: "profileRead", name: value.name });
  }
  if (value.kind === "profileWrite") {
    const profile = profileOf(value.profile);
    if (profile === undefined) return err(new Error("the profile is not in the expected form"));
    return ok({ kind: "profileWrite", profile });
  }
  if (value.kind === "mcpWrite" && Array.isArray(value.servers)) {
    const servers = value.servers.map(serverOf);
    if (servers.some((server) => server === undefined)) return err(new Error("a server is not in the expected form"));
    return ok({ kind: "mcpWrite", servers: servers as ScopedMcpServer[] });
  }
  if (
    value.kind === "answer" &&
    typeof value.id === "number" &&
    typeof value.text === "string" &&
    Array.isArray(value.chosen) &&
    value.chosen.every((index) => typeof index === "number")
  ) {
    return ok({ kind: "answer", id: value.id, chosen: value.chosen as number[], text: value.text });
  }
  if (value.kind === "treeRead" && typeof value.path === "string") {
    return ok({ kind: "treeRead", path: value.path });
  }
  if (value.kind === "fileRead" && typeof value.path === "string") {
    return ok({ kind: "fileRead", path: value.path });
  }
  if (value.kind === "fileWrite" && typeof value.path === "string" && typeof value.text === "string") {
    const base = typeof value.base === "string" ? value.base : undefined;
    return ok({ kind: "fileWrite", path: value.path, text: value.text, base });
  }
  if (value.kind === "fileClose" && typeof value.path === "string") {
    return ok({ kind: "fileClose", path: value.path });
  }
  if (value.kind === "providersWrite" && Array.isArray(value.servers)) {
    const servers = value.servers.map(providerOf);
    if (servers.some((server) => server === undefined)) return err(new Error("a server is not in the expected form"));
    return ok({ kind: "providersWrite", servers: servers as ProviderInput[] });
  }
  if (value.kind === "pickFolder") return ok({ kind: "pickFolder" });
  if (value.kind === "folderChange" && typeof value.path === "string" && value.path.trim() !== "") {
    return ok({ kind: "folderChange", path: value.path.trim() });
  }
  return err(new Error("unknown message"));
}
