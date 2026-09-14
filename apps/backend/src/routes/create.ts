import { mkdir, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { AppError, badRequest } from "../errors.js";
import { resolveForCreate } from "../fs.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";
import { mapFsError } from "./file.js";

function validateName(rel: string): void {
  if (!rel) throw badRequest("a name is required");
  const segments = rel.split("/");
  for (const seg of segments) {
    if (!seg) throw badRequest(`empty path segment in: ${rel}`);
    if (seg === "." || seg === "..")
      throw badRequest(`invalid path segment: ${seg}`);
    if (seg.includes("\\"))
      throw badRequest(`name cannot contain a backslash: ${seg}`);
    if (seg.length > 255) throw badRequest(`name too long (max 255): ${seg}`);
  }
}

/** Throw 400 if `target` already exists. */
async function assertDoesNotExist(target: string, rel: string): Promise<void> {
  try {
    await stat(target);
    throw badRequest(`already exists: ${rel}`);
  } catch (err) {
    if (err instanceof AppError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT")
      throw mapFsError(rel, err);
  }
}

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
        validateName(rel);
        const content = data.content ?? "";
        if (typeof content !== "string")
          throw badRequest('"content" must be a string');
        try {
          const target = await resolveForCreate(root, rel);
          await assertDoesNotExist(target, rel);
          await writeFile(target, content, "utf-8");
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
        validateName(rel);
        try {
          const target = await resolveForCreate(root, rel);
          await assertDoesNotExist(target, rel);
          await mkdir(target);
          sendJson(res, 201, { path: target });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw mapFsError(rel, err);
        }
      },
    },
  ];
}
