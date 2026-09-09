import { getListing, getFileContent, repoRoot } from "./listing.js";
import { resolveWithin } from "./pathGuard.js";

/**
 * Handles API requests. Currently supports:
 *   GET /api/listing[?path=relative/path] -> JSON array of entries (name, isDirectory).
 *   GET /api/file?path=relative/path      -> JSON { content: string }.
 * Returns a Response-like object { status, body } for the caller to send.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/listing") {
    try {
      const relPath = url.searchParams.get("path") ?? "";
      const dir = resolveWithin(repoRoot, relPath);
      if (!dir) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid path" }));
        return;
      }
      const entries = await getListing(dir);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(entries));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    try {
      const relPath = url.searchParams.get("path") ?? "";
      const filePath = resolveWithin(repoRoot, relPath);
      if (!filePath) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid path" }));
        return;
      }
      const content = await getFileContent(filePath);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ content }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}
