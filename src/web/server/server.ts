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
  // Starts a session in another folder, once the current one has ended. The page is kept.
  changeFolder?(path: string): Promise<Result<Session>>;
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
// What the page is told about input that arrives while the folder is changing.
const CHANGING_NOTICE = "the folder is changing, so this was not sent. Send it again when the change is done.";

export function startWebServer(options: WebServerOptions): Result<WebServer> {
  const { assets, token, port = 0 } = options;
  // The session that lines go to. It is undefined once a folder change has asked it to end.
  let session: Session | undefined = options.session;
  // running: lines go to the session. ending: the session has been asked to end for a folder change.
  // starting: the next session is being made. Input is accepted only while running.
  let phase: "running" | "ending" | "starting" = "running";
  // The folder the page asked for, while a change is under way.
  let folder: string | undefined;
  const hub = createHub((message) => {
    // A line or a request that arrives during a change gets a notice, so it is never dropped without a response.
    if (phase !== "running" || session === undefined) {
      hub.publish({ kind: "notice", text: CHANGING_NOTICE });
      return;
    }
    if (message.kind === "folderChange") {
      if (options.changeFolder === undefined) {
        hub.publish({ kind: "error", message: "the folder cannot be changed here" });
        return;
      }
      phase = "ending";
      folder = message.path;
      session.send({ kind: "inputEnded" });
      session = undefined;
      return;
    }
    session.send(message);
  });
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
  // Relays the events of one session. The session that ends for a folder change is not reported as ended,
  // though a failure in it is.
  async function relay(current: Session): Promise<"ended" | "switching"> {
    for await (const event of current.events()) {
      if (event.kind === "ended" && phase === "ending") {
        if (event.error !== undefined) hub.publish({ kind: "error", message: event.error });
        return "switching";
      }
      hub.publish(event);
      if (event.kind === "ended") return "ended";
    }
    return "ended";
  }
  void (async () => {
    let current: Session | undefined = session;
    while (current !== undefined) {
      if ((await relay(current)) === "ended" || folder === undefined) break;
      phase = "starting";
      const requested = folder;
      folder = undefined;
      const next = await options.changeFolder?.(requested);
      if (next === undefined) break;
      if (!next.ok) {
        hub.publish({ kind: "error", message: next.error.message });
        hub.publish({ kind: "ended", error: next.error.message });
        break;
      }
      current = next.value;
      session = current;
      phase = "running";
      hub.reset();
      // The page starts its transcript again; the new session then sends its own events.
      hub.publish({ kind: "history", messages: [] });
    }
    finish();
  })();
  return ok({
    url: `http://127.0.0.1:${server.port}/#t=${token}`,
    ended,
    stop: () => server.stop(false),
  });
}
