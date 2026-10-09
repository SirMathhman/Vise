import { formatError } from "../../output/format.ts";
import type { McpHub } from "../../mcp/mcp-hub.ts";
import {
  readEntries,
  removeEntry,
  saveEntry,
  type McpEntry,
  type McpScope,
} from "../../mcp/mcp-store.ts";

/**
 * The MCP settings tab's messages, answered at once and never queued behind a turn:
 *   browser → server: { type:"mcp_get" }
 *                     { type:"mcp_save", entry, from? }   add or change a server (`from` = the name and scope it had)
 *                     { type:"mcp_delete", name, scope }
 *                     { type:"mcp_restart", name }
 *   server → browser: { type:"mcp", servers, problems, saved?, error? }
 * Saving or deleting reloads the folder's hub, so the status shown is live; tools a
 * conversation already has stay as they were (they change when a page is reloaded).
 */
export async function handleMcpMessage(
  hub: McpHub | undefined,
  root: string,
  msg: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!hub) return { type: "mcp", servers: [], problems: [] };
  const type = msg["type"];
  let error: string | undefined;
  if (type === "mcp_save") {
    const result = saveEntry(toEntry(msg["entry"]), toRef(msg["from"]), root);
    if (!result.ok) error = formatError(result.error);
  } else if (type === "mcp_delete") {
    const result = removeEntry(String(msg["name"]), toScope(msg["scope"]), root);
    if (!result.ok) error = formatError(result.error);
  } else if (type === "mcp_restart") {
    const text = await hub.restart(String(msg["name"]));
    if (text.startsWith("error:")) error = text.slice(7);
  }
  if (type === "mcp_save" || type === "mcp_delete") await hub.reload();
  return view(hub, root, error, type === "mcp_save" && !error);
}

const toScope = (v: unknown): McpScope => (v === "global" ? "global" : "project");

const toRef = (v: unknown): { name: string; scope: McpScope } | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const ref = v as Record<string, unknown>;
  return typeof ref["name"] === "string"
    ? { name: ref["name"], scope: toScope(ref["scope"]) }
    : undefined;
};

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

function toEntry(v: unknown): McpEntry {
  const e = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  const env: Record<string, string> = {};
  if (typeof e["env"] === "object" && e["env"] !== null) {
    for (const [k, val] of Object.entries(e["env"])) {
      if (typeof val === "string") env[k] = val;
    }
  }
  return {
    name: typeof e["name"] === "string" ? e["name"] : "",
    scope: toScope(e["scope"]),
    command: typeof e["command"] === "string" ? e["command"].trim() : "",
    args: strings(e["args"]),
    env,
    disabled: e["disabled"] === true,
  };
}

/** The configured servers of both scopes with the live state of those running (a global server that a project one replaces is `shadowed`). */
function view(
  hub: McpHub,
  root: string,
  error: string | undefined,
  saved: boolean,
): Record<string, unknown> {
  const entries = readEntries(root);
  const live = new Map(hub.status().map((s) => [s.name, s]));
  const projectNames = new Set(
    entries.filter((e) => e.scope === "project").map((e) => e.name),
  );
  const servers = entries.map((e) => {
    const shadowed = e.scope === "global" && projectNames.has(e.name);
    const status = shadowed || e.disabled ? undefined : live.get(e.name);
    return {
      ...e,
      shadowed,
      state: e.disabled ? "disabled" : (status?.status.state ?? "off"),
      reason:
        status && "reason" in status.status ? status.status.reason : undefined,
      tools: status?.tools ?? 0,
      stderr: status?.stderr ?? "",
    };
  });
  return {
    type: "mcp",
    servers,
    problems: hub.problems,
    ...(error ? { error } : {}),
    ...(saved ? { saved: true } : {}),
  };
}
