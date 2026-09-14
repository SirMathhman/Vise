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
import { echoRoutes } from "./routes/echo.js";
import { healthRoutes } from "./routes/health.js";
import { helloRoutes } from "./routes/hello.js";

const routeGroups = [healthRoutes, helloRoutes, echoRoutes];

export function createApp(ctx: AppContext) {
  const routes = routeGroups.flatMap((group) => group(ctx));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!path.startsWith("/api/")) {
      toResponse(res, notFound());
      return;
    }

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

    try {
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
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export { type AppContext, createContext };
