import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { AppError, badRequest, forbidden, notFound } from "../errors.js";
import { resolveWithinRoot } from "../fs.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";

const MAX_BYTES = 1024 * 1024; // 1 MB

// A NUL byte in the leading window means the content is binary, not text.
const BINARY_SNIFF_BYTES = 8 * 1024;

function looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, BINARY_SNIFF_BYTES);
  return buf.subarray(0, end).includes(0);
}

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
          if (err instanceof Error && "code" in err) {
            const code = err.code as string;
            if (code === "ENOENT" || code === "ENOTDIR") throw notFound();
            if (code === "EACCES" || code === "EPERM") {
              throw forbidden(`no permission to read: ${rel}`);
            }
            if (code === "EISDIR") {
              throw badRequest(`expected a file, got a directory: ${rel}`);
            }
          }
          throw badRequest(`cannot read file: ${(err as Error).message}`);
        }
      },
    },
  ];
}
