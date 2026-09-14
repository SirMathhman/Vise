import type { AppContext } from "../context.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

export function healthRoutes(_ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/health",
      handler: (_req, res) => {
        sendJson(res, 200, { status: "ok", uptime: process.uptime() });
      },
    },
  ];
}
