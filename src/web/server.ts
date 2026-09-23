// The web entry point's server. Serves the static client (web/index.html,
// web/app.js, web/style.css, and marked's UMD build) over HTTP and owns a
// single WebSocket-driven session. On the first WS connection it constructs a
// WebTransport and hands it to run(config, transport); a second connection is
// rejected with "session in use" (MVP is single-session). When run() returns
// (the session ends), resolveSessionEnded fires and web.ts exits the process.
// No existing core module is modified; src/web/* imports from src/repl/*,
// src/config.ts, and src/transport.ts but is not imported by any of them.
import * as path from "node:path";
import type { Config } from "../config.ts";
import { run } from "../repl/loop.ts";
import { WebTransport } from "./webTransport.ts";

const PORT = 3000;

// Static file map: URL path -> file on disk (relative to the project root).
const STATIC_FILES: Record<string, string> = {
  "/": "web/index.html",
  "/index.html": "web/index.html",
  "/app.js": "web/app.js",
  "/style.css": "web/style.css",
  "/marked.umd.js": "node_modules/marked/lib/marked.umd.js",
};

// Content types by extension for the served files.
const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function contentType(file: string): string {
  return MIME_BY_EXT[path.extname(file)] ?? "application/octet-stream";
}

export async function createWebServer(config: Config): Promise<void> {
  // Tracks the active session's transport so a second connection can be
  // rejected (MVP single-session) and so close can tear it down.
  let active: WebTransport | null = null;

  // Resolved when run() returns for the active session. web.ts awaits this
  // to know the process should exit.
  let resolveSessionEnded: (() => void) | null = null;
  const sessionEnded = new Promise<void>((resolve) => {
    resolveSessionEnded = resolve;
  });

  const serveStatic = (req: Request): Response => {
    const url = new URL(req.url);
    const file = STATIC_FILES[url.pathname];
    if (!file) return new Response("Not Found", { status: 404 });
    return new Response(Bun.file(file), {
      headers: { "content-type": contentType(file) },
    });
  };

  Bun.serve({
    port: PORT,
    fetch: (req, server) => {
      if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (server.upgrade(req)) return undefined;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return serveStatic(req);
    },
    websocket: {
      open: (socket) => {
        if (active !== null) {
          socket.send("session in use");
          socket.close();
          return;
        }
        const transport = new WebTransport(socket);
        active = transport;
        void run(config, transport).finally(() => {
          active = null;
          resolveSessionEnded?.();
        });
      },
      message: (_socket, data) => {
        active?.handleMessage(data.toString());
      },
      close: (socket) => {
        // Browser disconnected (tab closed / network drop). Tear the
        // transport down so run() breaks out of its loop cleanly.
        active?.close();
        void socket;
      },
    },
  });

  console.log(`Vise web server listening on http://localhost:${PORT}`);

  return sessionEnded;
}
