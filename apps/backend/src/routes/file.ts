import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { sendJson } from "../http.js";
import { resolveWithinRoot } from "../fs.js";
import type { Route } from "../router.js";
import { AppError, badRequest, notFound } from "../errors.js";

const MAX_BYTES = 1024 * 1024; // 1 MB

const MISSING_CODES = new Set([
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "EACCES",
  "EPERM",
]);

export function fileRoutes(ctx: AppContext): Route[] {
  const root = resolve(ctx.rootPath);
  return [
    {
      method: "GET",
      pattern: "/api/file/*",
      handler: async (_req, res, params) => {
        const rel = params["rest"] ?? "";
        if (!rel) throw notFound();
        try {
          const target = await resolveWithinRoot(root, rel);
          const info = await stat(target);
          if (!info.isFile()) throw notFound();
          if (info.size > MAX_BYTES) {
            throw badRequest(
              `file too large to preview: ${info.size} bytes (max ${MAX_BYTES})`,
            );
          }
          const content = await readFile(target, "utf-8");
          sendJson(res, 200, { path: target, size: info.size, content });
        } catch (err) {
          if (err instanceof AppError) throw err;
          if (
            err instanceof Error &&
            "code" in err &&
            MISSING_CODES.has(err.code as string)
          ) {
            throw notFound();
          }
          throw badRequest(`cannot read file: ${(err as Error).message}`);
        }
      },
    },
  ];
}
