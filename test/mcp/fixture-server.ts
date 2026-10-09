// A tiny stdio MCP server for the tests: run with `bun fixture-server.ts`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { writeFileSync } from "node:fs";
import { z } from "zod";

// Lets a test find out whether this process is still alive.
if (process.env["FIXTURE_PIDFILE"]) {
  writeFileSync(process.env["FIXTURE_PIDFILE"], String(process.pid));
}

const server = new McpServer({ name: "fixture", version: "1.0.0" });

server.registerTool(
  "echo",
  { description: "Echo the text back", inputSchema: { text: z.string() } },
  ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
);
server.registerTool("fail", { description: "Always fails" }, () => ({
  isError: true,
  content: [{ type: "text", text: "boom" }],
}));
server.registerTool("crash", { description: "Kills the server" }, () => {
  process.exit(1);
});

await server.connect(new StdioServerTransport());
