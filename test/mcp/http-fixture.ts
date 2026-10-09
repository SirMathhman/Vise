// Tiny MCP servers over HTTP for the tests: Streamable HTTP, or the older SSE transport.
// Both refuse a request without `Authorization: Bearer secret`.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

function makeServer(): McpServer {
  const server = new McpServer({ name: "http-fixture", version: "1.0.0" });
  server.registerTool(
    "echo",
    { description: "Echo the text back", inputSchema: { text: z.string() } },
    ({ text }) => ({ content: [{ type: "text", text: `echo: ${text}` }] }),
  );
  return server;
}

async function body(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : undefined;
}

export interface HttpFixture {
  /** The address to put in the configuration. */
  url: string;
  close(): Promise<void>;
}

export async function startHttpFixture(
  mode: "streamable" | "sse",
): Promise<HttpFixture> {
  const sessions = new Map<string, SSEServerTransport>();
  const http = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.headers["authorization"] !== "Bearer secret") {
        res.writeHead(401).end("unauthorized");
        return;
      }
      const path = (req.url ?? "").split("?")[0];
      if (mode === "streamable" && path === "/mcp" && req.method === "POST") {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined,
        });
        const server = makeServer();
        res.on("close", () => void transport.close().then(() => server.close()));
        await server.connect(transport);
        await transport.handleRequest(req, res, await body(req));
      } else if (mode === "sse" && path === "/sse" && req.method === "GET") {
        const transport = new SSEServerTransport("/messages", res);
        sessions.set(transport.sessionId, transport);
        res.on("close", () => sessions.delete(transport.sessionId));
        await makeServer().connect(transport);
      } else if (mode === "sse" && path === "/messages" && req.method === "POST") {
        const id = new URL(req.url ?? "", "http://x").searchParams.get("sessionId");
        const transport = sessions.get(id ?? "");
        if (!transport) res.writeHead(404).end();
        else await transport.handlePostMessage(req, res, await body(req));
      } else {
        res.writeHead(404).end("not found");
      }
    })();
  });
  await new Promise<void>((done) => http.listen(0, "127.0.0.1", done));
  const port = (http.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/${mode === "sse" ? "sse" : "mcp"}`,
    close: () =>
      new Promise<void>((done) => {
        http.closeAllConnections();
        http.close(() => done());
      }),
  };
}
