import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { AppError, badRequest } from "../errors.js";
import { createDir, createFile, mapFsError } from "../fs.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

export function createRoutes(ctx: AppContext): Route[] {
  const root = resolve(ctx.rootPath);
  return [
    {
      method: "POST",
      pattern: "/api/file",
      handler: async (_req, res, _params, body) => {
        const data = body as { path?: unknown; content?: unknown };
        if (typeof data?.path !== "string")
          throw badRequest('"path" must be a string');
        const rel = data.path;
        const content = data.content ?? "";
        if (typeof content !== "string")
          throw badRequest('"content" must be a string');
        try {
          const target = await createFile(root, rel, content);
          sendJson(res, 201, {
            path: target,
            size: Buffer.byteLength(content),
          });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw mapFsError(rel, err);
        }
      },
    },
    {
      method: "POST",
      pattern: "/api/dir",
      handler: async (_req, res, _params, body) => {
        if (typeof body !== "object" || body === null || !("path" in body)) {
          throw badRequest('expected a JSON body with a "path" string');
        }
        const rel = (body as { path: unknown }).path;
        if (typeof rel !== "string")
          throw badRequest('"path" must be a string');
        try {
          const target = await createDir(root, rel);
          sendJson(res, 201, { path: target });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw mapFsError(rel, err);
        }
      },
    },
  ];
}
