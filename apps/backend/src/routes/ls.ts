import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { AppContext } from "../context.js";
import { sendJson } from "../http.js";
import type { Route } from "../router.js";
import { badRequest } from "../errors.js";

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
  return [
    {
      method: "GET",
      pattern: "/api/ls",
      handler: async (_req, res) => {
        const dir = resolve(ctx.rootPath);
        try {
          const items = await listDir(dir);
          sendJson(res, 200, { path: dir, items });
        } catch (err) {
          throw badRequest(`cannot list directory: ${(err as Error).message}`);
        }
      },
    },
  ];
}
