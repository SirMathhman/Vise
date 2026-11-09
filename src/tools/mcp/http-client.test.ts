import { afterEach, expect, test } from "bun:test";
import type { Ok } from "../../core/messages.ts";
import type { McpSession } from "./client.ts";
import { openHttpSession } from "./http-client.ts";

// A stand-in MCP endpoint. It gives a session id on initialize, answers tools/list as an event stream once
// the session id comes back, and records the headers of every request and each DELETE.
interface RequestBody {
  id?: number;
  method: string;
}

interface Seen {
  method: string;
  session: string | null;
  authorization: string | null;
}

let server: ReturnType<typeof Bun.serve> | undefined;
let seen: Seen[] = [];

function start(): string {
  seen = [];
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const session = request.headers.get("mcp-session-id");
      const authorization = request.headers.get("authorization");
      if (request.method === "DELETE") {
        seen.push({ method: "DELETE", session, authorization });
        return new Response(null, { status: 200 });
      }
      const body = (await request.json()) as RequestBody;
      seen.push({ method: body.method, session, authorization });
      if (body.method === "initialize") {
        return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }, {
          headers: { "mcp-session-id": "s1" },
        });
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (body.method === "tools/list" && session === "s1") {
        const event = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } });
        return new Response(`event: message\ndata: ${event}\n\n`, { headers: { "content-type": "text/event-stream" } });
      }
      if (body.method === "tools/call") {
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { message: "no such tool" } });
      }
      return new Response("no session", { status: 400 });
    },
  });
  return `http://127.0.0.1:${server.port}/mcp`;
}

afterEach(() => {
  server?.stop(true);
  server = undefined;
});

test("requests are answered as JSON or as an event stream, with the session id and the headers sent back", async () => {
  const url = start();
  const session = (openHttpSession(url, { Authorization: "Bearer t" }) as Ok<McpSession>).value;
  expect(await session.request("initialize", {})).toEqual({ ok: true, value: { protocolVersion: "2025-06-18" } });
  session.notify("notifications/initialized", {});
  expect(await session.request("tools/list", {})).toEqual({ ok: true, value: { tools: [] } });
  await session.stop();
  // initialize carried no session id; the later messages carried s1 and the authorization header.
  expect(seen[0]).toEqual({ method: "initialize", session: null, authorization: "Bearer t" });
  expect(seen.find((entry) => entry.method === "tools/list")).toEqual({ method: "tools/list", session: "s1", authorization: "Bearer t" });
  expect(seen.at(-1)).toEqual({ method: "DELETE", session: "s1", authorization: "Bearer t" });
});

test("an error answer from the server is returned as a failure", async () => {
  const url = start();
  const session = (openHttpSession(url, {}) as Ok<McpSession>).value;
  await session.request("initialize", {});
  const answer = await session.request("tools/call", { name: "missing" });
  expect(answer).toEqual({ ok: false, error: new Error("no such tool") });
  await session.stop();
});

test("a url that is not a URL is refused before anything is sent", () => {
  expect(openHttpSession("not a url", {}).ok).toBe(false);
});
