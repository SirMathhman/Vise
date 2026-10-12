import { tools } from "../tools.ts";
import type { DisplayLookup } from "../output/tool-line.ts";

const byName = new Map(tools.map((t) => [t.function.name, t.display]));

/** `mcp__<server>__<tool>`: a tool of an MCP server, whose own definition the display lookup does not hold. */
const MCP_NAME = /^mcp__[^_].*?__(.+)$/;

/** The display of a tool by name, from the tool definitions (what the terminal, the web server and history replay show). */
export const displayOfTool: DisplayLookup = (name) => {
  const known = byName.get(name);
  if (known) return known;
  const mcp = MCP_NAME.exec(name);
  return mcp ? { label: mcp[1] ?? name, icon: "🔌" } : undefined;
};
