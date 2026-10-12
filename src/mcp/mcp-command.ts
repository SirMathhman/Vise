import type { Result } from "@vise/core";
import { formatMcpStatus } from "../output/mcp-format.ts";
import type { McpStatusSource } from "../repl/ports.ts";

/** `/mcp` (servers and their state) and `/mcp restart <name>` (reconnect one; new tools reach a conversation only when it starts: a page reload or a Vise restart). */
export async function handleMcpCommand(
  mcp: McpStatusSource | undefined,
  line: string,
): Promise<Result<string>> {
  if (!mcp) {
    return { ok: true, value: "MCP is not available here" };
  }
  const [, sub, name] = line.trim().split(/\s+/);
  if (sub === undefined) {
    return { ok: true, value: formatMcpStatus(mcp.status(), mcp.problems) };
  }
  if (sub !== "restart" || !name) {
    return {
      ok: false,
      error: { kind: "malformed", body: "usage: /mcp | /mcp restart <name>" },
    };
  }
  const result = await mcp.restart(name);
  return result.startsWith("error:")
    ? { ok: false, error: { kind: "malformed", body: result.slice(7) } }
    : { ok: true, value: `${result}; any new tools reach a conversation only when a page is reloaded or Vise restarted` };
}
