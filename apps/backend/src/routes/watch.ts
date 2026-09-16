import type { ServerResponse } from "node:http";
import type { AppContext } from "../context.js";
import type { Route } from "../router.js";
import { createFileWatcher } from "../watch.js";

/**
 * A single app-wide watcher, created once for the app's root. Kept at module
 * scope so all concurrent SSE subscribers share one set of fs watchers.
 */
let sharedWatcher: ReturnType<typeof createFileWatcher> | undefined;

function getWatcher(rootPath: string) {
  if (!sharedWatcher) {
    sharedWatcher = createFileWatcher(rootPath);
    sharedWatcher.start();
  }
  return sharedWatcher;
}

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
        const watcher = getWatcher(ctx.rootPath);
        writeSseHeaders(res);

        const unsubscribe = watcher.subscribe((e) => {
          res.write(`data: ${JSON.stringify(e)}\n\n`);
        });

        res.on("close", unsubscribe);
      },
    },
  ];
}
