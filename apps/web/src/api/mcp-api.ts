import { formatError } from "@vise/backend";
import { globalDataDir } from "@vise/backend";
import type { McpHub } from "@vise/backend";
import {
  readEntries,
  removeEntry,
  saveEntry,
  type McpEntry,
  type McpScope,
} from "@vise/backend";
import { strings } from "./wire/reply.ts";

/**
 * The MCP settings tab's messages, answered at once and never queued behind a turn:
 *   browser → server: { type:"mcp_get" }
 *                     { type:"mcp_save", entry, from? }   add or change a server (`from` = the name and scope it had)
 *                     { type:"mcp_delete", name, scope }
 *                     { type:"mcp_restart", name }
 *   server → browser: { type:"mcp", servers, problems, saved?, deleted?, error? }   (the page reloads after `saved`/`deleted`, which gives its conversation the changed tools)
 * Saving or deleting reloads the folder's hub, so the status shown is live; tools a
 * conversation already has stay as they were (they change when a page is reloaded).
 */
export async function handleMcpMessage(
  hub: McpHub | undefined,
  root: string,
  msg: Record<string, unknown>,
  globalDir: string = globalDataDir,
): Promise<Record<string, unknown>> {
  if (!hub) return { type: "mcp", servers: [], problems: [] };
  const type = msg["type"];
  let error: string | undefined;
  if (type === "mcp_save") {
    const result = saveEntry(toEntry(msg["entry"]), toRef(msg["from"]), root, globalDir);
    if (!result.ok) error = formatError(result.error);
  } else if (type === "mcp_delete") {
    const result = removeEntry(String(msg["name"]), toScope(msg["scope"]), root, globalDir);
    if (!result.ok) error = formatError(result.error);
  } else if (type === "mcp_restart") {
    const text = await hub.restart(String(msg["name"]));
    if (text.startsWith("error:")) error = text.slice(7);
  }
  if (type === "mcp_save" || type === "mcp_delete") await hub.reload();
  const changed = error
    ? undefined
    : type === "mcp_save"
      ? "saved"
      : type === "mcp_delete"
        ? "deleted"
        : undefined;
  return view(hub, root, globalDir, error, changed);
}

const toScope = (v: unknown): McpScope => (v === "global" ? "global" : "project");

const toRef = (v: unknown): { name: string; scope: McpScope } | undefined => {
  if (typeof v !== "object" || v === null) return undefined;
  const ref = v as Record<string, unknown>;
  return typeof ref["name"] === "string"
    ? { name: ref["name"], scope: toScope(ref["scope"]) }
    : undefined;
};


function toEntry(v: unknown): McpEntry {
  const e = (typeof v === "object" && v !== null ? v : {}) as Record<
    string,
    unknown
  >;
  const common = {
    name: typeof e["name"] === "string" ? e["name"] : "",
    scope: toScope(e["scope"]),
    disabled: e["disabled"] === true,
  };
  // A remote server is told apart by carrying a `url` (possibly still empty in the form).
  if ("url" in e) {
    const url = typeof e["url"] === "string" ? e["url"].trim() : "";
    return { ...common, url, headers: stringMap(e["headers"]) };
  }
  return {
    ...common,
    command: typeof e["command"] === "string" ? e["command"].trim() : "",
    args: strings(e["args"]),
    env: stringMap(e["env"]),
  };
}

function stringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof v === "object" && v !== null) {
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
    }
  }
  return out;
}

/** The configured servers of both scopes with the live state of those running (a global server that a project one replaces is `shadowed`). */
function view(
  hub: McpHub,
  root: string,
  globalDir: string,
  error: string | undefined,
  changed: "saved" | "deleted" | undefined,
): Record<string, unknown> {
  const entries = readEntries(root, globalDir);
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
    ...(changed ? { [changed]: true } : {}),
  };
}
