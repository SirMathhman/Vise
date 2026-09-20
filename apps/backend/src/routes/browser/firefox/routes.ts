import type { IncomingMessage } from "node:http";
import type { AppContext } from "../../../context.js";
import { badRequest, forbidden } from "../../../errors.js";
import { sendJson } from "../../../http.js";
import type { Route } from "../../../router.js";
import type { BridgeResult } from "./bridge.js";

/**
 * The extension's side of the bridge (see bridge.ts): a long poll for the next
 * command, the result of a command, and a goodbye. Like every /api route these
 * are unauthenticated, but a web page must not be able to drive them (it could
 * feed the model forged page results, or detach the extension), so each
 * request must carry a custom header. A page can't add one to a cross-origin
 * request without a CORS preflight, which this server never approves; the
 * extension, with host permission, can.
 */
function requireBridgeHeader(req: IncomingMessage): void {
  if (req.headers["x-vise-bridge"] !== "1") {
    throw forbidden("missing bridge header");
  }
}

export function firefoxBridgeRoutes(ctx: AppContext): Route[] {
  const bridge = ctx.firefoxBridge;
  return [
    {
      method: "GET",
      pattern: "/api/firefox/poll",
      handler: async (req, res) => {
        requireBridgeHeader(req);
        const cmd = await bridge.poll();
        if (!cmd) {
          res.writeHead(204);
          res.end();
          return;
        }
        // The poll's connection may have died while it waited (the extension
        // reloaded): don't lose the command with it. (Only the response side
        // says so: Node marks a fully-read GET request destroyed at once.)
        if (res.destroyed) {
          bridge.requeue(cmd);
          return;
        }
        sendJson(res, 200, cmd);
      },
    },
    {
      method: "POST",
      pattern: "/api/firefox/result",
      handler: (req, res, _params, body) => {
        requireBridgeHeader(req);
        const r = (body ?? {}) as Partial<BridgeResult>;
        if (typeof r.id !== "string") throw badRequest("id is required");
        bridge.deliver({
          id: r.id,
          ok: r.ok === true,
          result: typeof r.result === "string" ? r.result : undefined,
          images: Array.isArray(r.images)
            ? r.images.filter((i): i is string => typeof i === "string")
            : undefined,
          error: typeof r.error === "string" ? r.error : undefined,
        });
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "POST",
      pattern: "/api/firefox/goodbye",
      handler: (req, res) => {
        requireBridgeHeader(req);
        bridge.goodbye();
        sendJson(res, 200, { ok: true });
      },
    },
    {
      method: "GET",
      pattern: "/api/firefox/status",
      handler: (_req, res) => {
        sendJson(res, 200, { connected: bridge.connected() });
      },
    },
  ];
}
