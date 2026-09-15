import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { AppError, badRequest, notFound } from "../errors.js";
import { looksBinary, mapFsError, resolveWithinRoot } from "../fs.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

const MAX_BYTES = 1024 * 1024; // 1 MB

export function fileRoutes(ctx: AppContext): Route[] {
  const root = resolve(ctx.rootPath);
  return [
    {
      method: "GET",
      pattern: "/api/file/*",
      handler: async (_req, res, params) => {
        const rel = params.rest ?? "";
        if (!rel) throw notFound();
        try {
          const target = await resolveWithinRoot(root, rel);
          const info = await stat(target);
          if (!info.isFile()) throw notFound();
          if (info.size > MAX_BYTES) {
            throw badRequest(
              `file too large to preview: ${info.size} bytes (max ${MAX_BYTES})`
            );
          }
          const buf = await readFile(target);
          if (looksBinary(buf)) {
            throw badRequest(
              `cannot preview binary file: ${rel} (${info.size} bytes)`
            );
          }
          sendJson(res, 200, {
            path: target,
            size: info.size,
            content: buf.toString("utf-8"),
          });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw mapFsError(rel, err);
        }
      },
    },
    {
      method: "PUT",
      pattern: "/api/file/*",
      handler: async (_req, res, params, body) => {
        const rel = params.rest ?? "";
        if (!rel) throw notFound();
        if (typeof body !== "object" || body === null || !("content" in body)) {
          throw badRequest(`expected a JSON body with a "content" string`);
        }
        const content = (body as { content: unknown }).content;
        if (typeof content !== "string") {
          throw badRequest(`"content" must be a string`);
        }
        const buf = Buffer.from(content, "utf-8");
        if (buf.length > MAX_BYTES) {
          throw badRequest(
            `file too large to save: ${buf.length} bytes (max ${MAX_BYTES})`
          );
        }
        try {
          const target = await resolveWithinRoot(root, rel);
          const info = await stat(target);
          if (!info.isFile()) throw notFound();
          if (looksBinary(await readFile(target))) {
            throw badRequest(`cannot edit binary file: ${rel}`);
          }
          await writeFile(target, buf);
          sendJson(res, 200, { path: target, size: buf.length });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw mapFsError(rel, err);
        }
      },
    },
    {
      method: "DELETE",
      pattern: "/api/file/*",
      handler: async (_req, res, params) => {
        const rel = params.rest ?? "";
        if (!rel) throw notFound();
        try {
          const target = await resolveWithinRoot(root, rel);
          const info = await stat(target);
          if (!info.isFile()) throw notFound();
          await unlink(target);
          sendJson(res, 200, { path: target, deleted: true });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw mapFsError(rel, err);
        }
      },
    },
  ];
}
