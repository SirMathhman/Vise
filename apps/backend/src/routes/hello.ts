import type { AppContext } from "../context.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

export function helloRoutes(_ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/hello/:name",
      handler: (_req, res, params) => {
        sendJson(res, 200, { message: `Hello, ${params.name}!` });
      },
    },
  ];
}
