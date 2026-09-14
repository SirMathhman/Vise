import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { readJsonBody } from "./json.js";

export interface AppContext {
  now: () => Date;
}

export function createContext(): AppContext {
  return { now: () => new Date() };
}

interface Route {
  method: string;
  pattern: string;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
    body: unknown,
  ) => Promise<void> | void;
}

export function createApp(ctx: AppContext) {
  const routes: Route[] = [
    {
      method: "GET",
      pattern: "/api/health",
      handler: (_req, res) => {
        sendJson(res, 200, { status: "ok", uptime: process.uptime() });
      },
    },
    {
      method: "GET",
      pattern: "/api/hello/:name",
      handler: (_req, res, params) => {
        sendJson(res, 200, { message: `Hello, ${params.name}!` });
      },
    },
    {
      method: "POST",
      pattern: "/api/echo",
      handler: (_req, res, _params, body) => {
        sendJson(res, 200, { echo: body ?? null });
      },
    },
  ];

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path.startsWith("/api/")) {
      const match = matchRoute(routes, req.method ?? "GET", path);
      if (match) {
        let body: unknown;
        try {
          body = await readJsonBody(req);
        } catch (err) {
          sendJson(res, 400, {
            error: "bad_request",
            message: (err as Error).message,
          });
          return;
        }
        try {
          await match.route.handler(req, res, match.params, body);
          return;
        } catch (err) {
          sendJson(res, 500, { error: "internal_error", message: String(err) });
          return;
        }
      }
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  });

  return {
    listen(port: number, host = "0.0.0.0"): Promise<void> {
      return new Promise((resolve) =>
        server.listen(port, host, () => resolve()),
      );
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function matchRoute(
  routes: Route[],
  method: string,
  path: string,
): { route: Route; params: Record<string, string> } | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, path);
    if (params) return { route, params };
  }
  return null;
}

function matchPattern(
  pattern: string,
  path: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = path.split("/").filter(Boolean);
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    if (p.startsWith(":")) {
      params[p.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (p !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

export const ctx = createContext();
