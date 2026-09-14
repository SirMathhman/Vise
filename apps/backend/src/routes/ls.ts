import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { sendJson } from "../http.js";
import { resolveWithinRoot } from "../fs.js";
import type { Route } from "../router.js";
import { AppError, badRequest } from "../errors.js";

export interface DirEntry {
  name: string;
  kind: "file" | "directory";
}

export async function listDir(path: string): Promise<DirEntry[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const items: DirEntry[] = entries.map((e) => ({
    name: e.name,
    kind: e.isDirectory() ? "directory" : "file",
  }));
  items.sort((a, b) =>
    a.kind === b.kind
      ? a.name.localeCompare(b.name)
      : a.kind === "directory"
        ? -1
        : 1,
  );
  return items;
}

export function lsRoutes(ctx: AppContext): Route[] {
  const root = resolve(ctx.rootPath);
  return [
    {
      method: "GET",
      pattern: "/api/ls/*",
      handler: async (_req, res, params) => {
        const rel = params["rest"] ?? "";
        try {
          const dir = await resolveWithinRoot(root, rel);
          const items = await listDir(dir);
          sendJson(res, 200, { path: dir, items });
        } catch (err) {
          if (err instanceof AppError) throw err;
          throw badRequest(`cannot list directory: ${(err as Error).message}`);
        }
      },
    },
  ];
}
