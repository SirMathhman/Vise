import type { AppContext } from "../context.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

export function echoRoutes(_ctx: AppContext): Route[] {
  return [
    {
      method: "POST",
      pattern: "/api/echo",
      handler: (_req, res, _params, body) => {
        sendJson(res, 200, { echo: body ?? null });
      },
    },
  ];
}
