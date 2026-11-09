import type { McpServerEntry } from "../core/messages.ts";
import type { Emit } from "../protocol/protocol.ts";
import type { SessionPorts } from "./ports.ts";

// The MCP server editing the page does. Each function answers with events and never throws; a failure is
// reported, and the session goes on.

// Sends the servers: the ones that started at the start of this session, and the ones the file configures.
// Sent at the start and after each save.
export async function announceMcp(ports: SessionPorts, emit: Emit): Promise<void> {
  if (ports.mcp === undefined) return;
  const config = await ports.mcp.config();
  if (!config.ok) {
    emit({ kind: "error", message: `could not read the MCP servers: ${config.error.message}` });
    return;
  }
  emit({ kind: "mcp", running: ports.mcp.running(), servers: config.value.map(withoutValues) });
}

// An endpoint's header values are secrets, so the page gets each header name with a blank value.
function withoutValues(server: McpServerEntry): McpServerEntry {
  if (server.kind !== "http") return server;
  const headers: Record<string, string> = {};
  for (const header of Object.keys(server.headers)) headers[header] = "";
  return { ...server, headers };
}

// Writes the servers the page sent, then sends them again. A change applies at the next start.
export async function writeMcpFor(
  ports: SessionPorts,
  emit: Emit,
  servers: McpServerEntry[],
): Promise<void> {
  if (ports.mcp === undefined) {
    emit({ kind: "error", message: "MCP servers are not available here" });
    return;
  }
  const saved = await ports.mcp.save(servers);
  if (!saved.ok) {
    emit({ kind: "error", message: `could not save the MCP servers: ${saved.error.message}` });
    return;
  }
  emit({ kind: "notice", text: "saved the MCP servers; a change applies at the next start" });
  await announceMcp(ports, emit);
}
