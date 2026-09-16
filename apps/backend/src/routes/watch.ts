import type { ServerResponse } from "node:http";
import type { AppContext } from "../context.js";
import type { Route } from "../router.js";

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  // Prime the stream; some clients only fire "open" after the first bytes.
  res.write(":ok\n\n");
}

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
      handler: (_req, res) => {
        writeSseHeaders(res);

        const unsubscribe = ctx.fileWatcher.subscribe((e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        });

        res.on("close", unsubscribe);
      },
    },
  ];
}
