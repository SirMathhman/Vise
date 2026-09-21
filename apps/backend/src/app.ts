import type { IncomingMessage, ServerResponse } from "node:http";
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
import type { Route } from "./router.js";
import { matchRoute } from "./router.js";
import { firefoxBridgeRoutes } from "./routes/browser/firefox/routes.js";
import { browserViewRoutes } from "./routes/browser/view.js";
import { createRoutes } from "./routes/create.js";
import { echoRoutes } from "./routes/echo.js";
import { fileRoutes } from "./routes/file.js";
import { healthRoutes } from "./routes/health.js";
import { helloRoutes } from "./routes/hello.js";
import { llmToolRoutes } from "./routes/llm.js";
import { closeBackgroundCommands } from "./routes/llmCommand.js";
import { llmForwardRoutes } from "./routes/llmForward.js";
import { lsRoutes } from "./routes/ls.js";
import { staticRoutes } from "./routes/static.js";
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
  firefoxBridgeRoutes,
];

export function createApp(ctx: AppContext) {
  const routes = routeGroups.flatMap((group) => group(ctx));
  // Web routes are consulted for non-/api/ paths: /llm/* is forwarded to the
  // upstream LLM server, everything else is served from the built frontend
  // (when a static directory is configured). llmForwardRoutes comes first so
  // its more specific pattern wins over the static catch-all.
  const webRoutes = [...llmForwardRoutes(ctx), ...staticRoutes(ctx)];

  // The app owns the filesystem watcher's lifecycle: start it with the app
  // and close it on shutdown so it doesn't keep the event loop alive.
  ctx.fileWatcher.start();

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    // /api/ paths hit the JSON route groups; everything else hits the web
    // routes (the /llm forward + static frontend). A streaming route (SSE,
    // the /llm forward) owns its response, so it is dispatched without a
    // JSON body and with a no-op error path once headers are sent (see
    // dispatch).
    const match = matchRoute(
      path.startsWith("/api/") ? routes : webRoutes,
      req.method ?? "GET",
      path
    );
    if (!match) {
      toResponse(res, notFound());
      return;
    }
    await dispatch(match, req, res);
  });

  async function dispatch(
    match: { route: Route; params: Record<string, string> },
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const { route } = match;
    if (route.streaming) {
      // A streaming route owns the response: it writes headers and bytes
      // itself, so there is no JSON body to read. On error we only write a
      // structured response if the route has not already opened the stream;
      // once headers are sent we just close it (the route is responsible for
      // whatever it managed to write).
      try {
        await route.handler(req, res, match.params, undefined);
      } catch (err) {
        if (!res.headersSent) {
          toResponse(res, err instanceof AppError ? err : internal());
        } else {
          res.end();
        }
      }
      return;
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      toResponse(res, badRequest((err as Error).message));
      return;
    }
    try {
      await route.handler(req, res, match.params, body);
    } catch (err) {
      toResponse(res, err instanceof AppError ? err : internal());
    }
  }

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
          closeBackgroundCommands();
          await ctx.browserSession.close();
          resolve();
        });
      }),
  };
}

export { type AppContext, createContext };
