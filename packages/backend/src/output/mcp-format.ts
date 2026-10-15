/** One MCP server as the status views see it (structurally what `McpHub.status()` returns). */
export interface McpServerLine {
  name: string;
  status: { state: string; reason?: string };
  tools: number;
  stderr: string;
}

/** The `/mcp` listing: each server with its state, tool count and, when it is not working, why. */
export function formatMcpStatus(servers: McpServerLine[], problems: string[]): string {
  if (servers.length === 0 && problems.length === 0) {
    return 'no MCP servers configured (add "mcpServers" to .viserc.json or ~/.vise/mcp.json)';
  }
  const lines = servers.map((s) => {
    const why = s.status.reason ? `: ${s.status.reason}` : "";
    const base = `${s.name}  ${s.status.state}${why}  (${s.tools} tools)`;
    return s.status.state === "ready" || s.stderr === ""
      ? base
      : `${base}\n    ${s.stderr.split("\n").join("\n    ")}`;
  });
  return [...lines, ...problems.map((p) => `skipped: ${p}`)].join("\n");
}

/** A startup notice naming the servers that did not come up and the config entries skipped; undefined when all is well. */
export function mcpNote(hub: {
  status(): McpServerLine[];
  problems: string[];
}): string | undefined {
  const failed = hub
    .status()
    .filter((s) => s.status.state !== "ready")
    .map((s) => `MCP server ${s.name} is unavailable (${s.status.reason ?? s.status.state})`);
  const notes = [...failed, ...hub.problems.map((p) => `MCP: ${p}`)];
  return notes.length === 0 ? undefined : notes.join("\n");
}
