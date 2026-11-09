import { timingSafeEqual } from "node:crypto";
import { err, ok, type Result } from "../../core/messages.ts";
import type { Session } from "../../protocol/protocol.ts";
import { createHub } from "./hub.ts";

// The files the page is made of, served at fixed paths.
export interface WebAssets {
  html: string;
  script: string;
  style: string;
}

export interface WebServerOptions {
  session: Session;
  assets: WebAssets;
  // The secret that a browser must send with its connection. Printed once, in the URL.
  token: string;
  // The port to listen on. 0, the default, picks a free one.
  port?: number;
}

export interface WebServer {
  // The address to open, with the token in its fragment so it stays out of server logs.
  url: string;
  // Resolves once the session has ended and its last event has been sent.
  ended: Promise<void>;
  stop(): void;
}

function sameToken(given: string, token: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function assetResponse(pathname: string, assets: WebAssets): Response {
  switch (pathname) {
    case "/":
      return new Response(assets.html, {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    case "/app.js":
      return new Response(assets.script, {
        headers: { "content-type": "text/javascript; charset=utf-8" },
      });
    case "/style.css":
      return new Response(assets.style, {
        headers: { "content-type": "text/css; charset=utf-8" },
      });
    default:
      return new Response("not found", { status: 404 });
  }
}

// Serves the page on 127.0.0.1 and relays the session over one WebSocket at /ws. The socket is
// accepted only from the page's own origin and with the token. The page itself is public: it holds
// nothing a web page elsewhere could use.
export function startWebServer(options: WebServerOptions): Result<WebServer> {
  const { session, assets, token, port = 0 } = options;
  const hub = createHub((message) => session.send(message));
  const { promise: ended, resolve: finish } = Promise.withResolvers<void>();
  let server: ReturnType<typeof Bun.serve<undefined>>;
  try {
    server = Bun.serve<undefined>({
      hostname: "127.0.0.1",
      port,
      fetch(request, srv) {
        const url = new URL(request.url);
        if (url.pathname !== "/ws") return assetResponse(url.pathname, assets);
        const origin = `http://127.0.0.1:${srv.port}`;
        if (request.headers.get("origin") !== origin) {
          return new Response("forbidden", { status: 403 });
        }
        const given = url.searchParams.get("t") ?? "";
        if (!sameToken(given, token)) {
          return new Response("forbidden", { status: 403 });
        }
        return srv.upgrade(request, { data: undefined })
          ? undefined
          : new Response("expected a WebSocket upgrade", { status: 400 });
      },
      websocket: {
        open(socket) {
          hub.attach(socket);
        },
        message(socket, message) {
          hub.receive(socket, String(message));
        },
        close(socket) {
          hub.detach(socket);
        },
      },
    });
  } catch (error) {
    return err(error instanceof Error ? error : new Error(String(error)));
  }
  void (async () => {
    for await (const event of session.events()) {
      hub.publish(event);
      if (event.kind === "ended") break;
    }
    finish();
  })();
  return ok({
    url: `http://127.0.0.1:${server.port}/#t=${token}`,
    ended,
    stop: () => server.stop(false),
  });
}
