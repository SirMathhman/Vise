import type { AppContext } from "../context.js";
import { sendSseHeaders } from "../http.js";
import type { Route } from "../router.js";

/**
 * GET /api/watch — server-sent stream of debounced filesystem change events
 * under the app root. Each event is `data: <json>\n\n` with a `path` relative
 * to the root and an `event` kind. The stream ends when the client disconnects.
 */
export function watchRoutes(ctx: AppContext): Route[] {
  return [
    {
      method: "GET",
      pattern: "/api/watch",
      streaming: true,
      handler: (_req, res) => {
        sendSseHeaders(res);

        const unsubscribe = ctx.fileWatcher.subscribe((e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        });

        res.on("close", unsubscribe);
      },
    },
  ];
}
