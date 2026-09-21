import { readFile, stat } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve } from "node:path";
import type { AppContext } from "../context.js";
import { notFound } from "../errors.js";
import { resolveWithinRoot } from "../fs.js";
import type { Route } from "../router.js";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

/**
 * Serves the built frontend (`apps/frontend/dist`, or wherever the caller
 * pointed `ctx.staticDir`) from the app's origin, so a production / Electron
 * build has a single same-origin host for the SPA alongside /api and /llm.
 * Only mounted when `ctx.staticDir` is set — a dev run without one (the Vite
 * dev server serves the frontend instead) registers no static route, and the
 * `/api/`-only 404 behavior is preserved.
 *
 * Fallback rules (standard SPA behavior): a request for a real file is
 * served; a request for a path that doesn't exist and has a file extension
 * (a hashed asset from a previous build) is a 404 — serving index.html for
 * it would hand the browser HTML where it expects JS/CSS; anything else
 * (no extension, an SPA route) falls back to index.html so client-side
 * routing and deep links work.
 */
export function staticRoutes(ctx: AppContext): Route[] {
  const staticDir = ctx.staticDir;
  if (!staticDir) return [];
  const root = resolve(staticDir);
  return [
    {
      method: "GET",
      pattern: "/*",
      handler: async (_req, res, params) => {
        const rel = params.rest ?? "";
        const candidate = rel === "" ? "index.html" : rel;
        let target: string;
        try {
          target = await resolveWithinRoot(root, candidate);
        } catch {
          // Non-existent file (ENOENT from realpath): fall through to
          // the SPA/404 logic below.
          if (extname(candidate) !== "") throw notFound();
          await serveIndex(res, root);
          return;
        }
        const info = await stat(target).catch(() => undefined);
        if (info?.isFile()) {
          const type = MIME[extname(candidate).toLowerCase()];
          res.writeHead(200, {
            "Content-Type": type ?? "application/octet-stream",
            "Cache-Control": "no-cache",
          });
          res.end(await readFile(target));
          return;
        }
        if (extname(candidate) !== "") throw notFound();
        await serveIndex(res, root);
      },
    },
  ];
}

async function serveIndex(res: ServerResponse, root: string): Promise<void> {
  try {
    const buf = await readFile(resolve(root, "index.html"));
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  } catch {
    throw notFound();
  }
}
