import http from "node:http";
import type { AppContext } from "../context.js";
import type { Route } from "../router.js";

/**
 * Production replacement for the Vite dev proxy's `/llm` rewrite. The dev
 * server forwards `/llm/*` to llama.cpp on :8080 with the `/llm` prefix
 * stripped; this route does the same thing from the backend, so a single
 * same-origin host serves the SPA, /api, and /llm in a production build
 * (see docs/architecture.md, "LLM traffic has no production path"). Only
 * mounted when `ctx.llmUpstream` is set — a plain `node dist/index.js` dev run
 * without `LLM_UPSTREAM` never registers these routes, matching the
 * frontend's dev-only dependency on the Vite proxy.
 */

/** Copy a header value through if present and not a hop-by-hop one. */
function copyHeader(
  from: http.IncomingHttpHeaders,
  res: http.ServerResponse,
  name: string
): void {
  const value = from[name];
  if (value === undefined || Array.isArray(value)) return;
  res.setHeader(name, value);
}

export function llmForwardRoutes(ctx: AppContext): Route[] {
  const upstream = ctx.llmUpstream;
  if (!upstream) return [];
  const handler: Route["handler"] = (req, res) => {
    void forward(ctx, req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "llm_upstream_error" }));
      } else {
        res.end();
      }
    });
  };
  return [
    { method: "GET", pattern: "/llm/*", streaming: true, handler },
    { method: "POST", pattern: "/llm/*", streaming: true, handler },
  ];
}

async function forward(
  ctx: AppContext,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const upstream = ctx.llmUpstream;
  if (!upstream) {
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "llm_upstream_not_configured" }));
    return;
  }
  const path = (req.url ?? "/").replace(/^\/llm/, "") || "/";
  const url = new URL(upstream);
  const target = new URL(path, url);
  const buf = await readBody(req);
  // Tear down the upstream request when the client goes away, so an
  // abandoned stream (user clicks Stop, navigates away, or closes the
  // window) doesn't keep llama.cpp generating to a dead connection.
  let upstreamReq: http.ClientRequest | null = null;
  req.on("close", () => {
    upstreamReq?.destroy();
  });
  await new Promise<void>((resolveP, rejectP) => {
    const headers: Record<string, string> = {};
    const contentType = req.headers["content-type"];
    if (contentType !== undefined)
      headers["content-type"] = String(contentType);
    const authorization = req.headers.authorization;
    if (authorization !== undefined)
      headers.authorization = String(authorization);
    if (buf.length > 0) headers["content-length"] = String(buf.length);
    upstreamReq = http.request(
      {
        protocol: url.protocol,
        host: url.host,
        port: url.port,
        path: target.pathname + target.search,
        method: req.method,
        headers,
      },
      (upstreamRes) => {
        if (upstreamRes === null) {
          finish(res, 502, { error: "llm_upstream_no_response" });
          return;
        }
        const status = upstreamRes.statusCode ?? 502;
        const statusMessage = upstreamRes.statusMessage;
        if (statusMessage) res.writeHead(status, statusMessage);
        else res.writeHead(status);
        copyHeader(upstreamRes.headers, res, "content-type");
        copyHeader(upstreamRes.headers, res, "access-control-allow-origin");
        upstreamRes.pipe(res);
        upstreamRes.on("error", (err) => {
          rejectP(err);
        });
        upstreamRes.on("end", () => resolveP());
      }
    );
    upstreamReq.on("error", (err) => {
      if (!res.headersSent) {
        finish(res, 502, {
          error: "llm_upstream_unreachable",
          message: `cannot reach LLM upstream at ${upstream}: ${(err as Error).message}`,
        });
      } else {
        res.end();
      }
      rejectP(err);
    });
    if (buf.length > 0) upstreamReq.write(buf);
    upstreamReq.end();
  });
}

function finish(
  res: http.ServerResponse,
  status: number,
  body: Record<string, string>
): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
