import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/**
 * Serves a single file from `rootDir` for the given request path, or returns
 * null if the file does not exist (so the caller can fall back to index.html).
 * Guards against path traversal outside of `rootDir`.
 */
export async function serveFile(req, res, rootDir, reqPath) {
  const root = resolve(rootDir);
  const rel = normalize(decodeURIComponent(reqPath)).replace(/^([/\\])+/, "");
  const filePath = resolve(join(root, rel));

  if (
    filePath !== root &&
    !filePath.startsWith(root + (root.endsWith("\\") ? "" : "\\"))
  ) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Forbidden" }));
    return true;
  }

  let target = filePath;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) target = join(filePath, "index.html");
  } catch {
    return false;
  }

  try {
    const data = await readFile(target);
    const type =
      MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  } catch {
    return false;
  }
  return true;
}
