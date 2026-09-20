import { createServer } from "node:http";
import type { AppContext } from "./context.js";
import { createContext } from "./context.js";
import {
  AppError,
  badRequest,
  internal,
  notFound,
  toResponse,
} from "./errors.js";
import { readJsonBody } from "./json.js";
import { matchRoute } from "./router.js";
import { browserViewRoutes } from "./routes/browserView.js";
import { createRoutes } from "./routes/create.js";
import { echoRoutes } from "./routes/echo.js";
import { fileRoutes } from "./routes/file.js";
import { healthRoutes } from "./routes/health.js";
import { helloRoutes } from "./routes/hello.js";
import { llmToolRoutes } from "./routes/llm.js";
import { lsRoutes } from "./routes/ls.js";
import { watchRoutes } from "./routes/watch.js";

const routeGroups = [
  healthRoutes,
  helloRoutes,
  echoRoutes,
  lsRoutes,
  fileRoutes,
  createRoutes,
  llmToolRoutes,
  watchRoutes,
  browserViewRoutes,
];

export function createApp(ctx: AppContext) {
  const routes = routeGroups.flatMap((group) => group(ctx));

  // The app owns the filesystem watcher's lifecycle: start it with the app
  // and close it on shutdown so it doesn't keep the event loop alive.
  ctx.fileWatcher.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      toResponse(res, notFound());
      return;
    }

    try {
      const match = matchRoute(routes, req.method ?? "GET", path);
      if (!match) {
        toResponse(res, notFound());
        return;
      }

      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        toResponse(res, badRequest((err as Error).message));
        return;
      }

      await match.route.handler(req, res, match.params, body);
    } catch (err) {
      toResponse(res, err instanceof AppError ? err : internal());
    }
  });

  return {
    listen(port: number, host = "0.0.0.0"): Promise<void> {
      return new Promise((resolve) =>
        server.listen(port, host, () => resolve())
      );
    },
    close: () =>
      new Promise<void>((resolve) => {
        // server.close() only stops NEW connections; existing ones (notably an
        // open /api/watch SSE stream) keep it open until they drain, so the
        // close callback — and the watcher teardown — would never run. Force
        // them to terminate so shutdown completes.
        server.closeAllConnections();
        server.close(async () => {
          ctx.fileWatcher.close();
          await ctx.browserSession.close();
          resolve();
        });
      }),
  };
}

export { type AppContext, createContext };
