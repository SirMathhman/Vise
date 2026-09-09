import { getListing, repoRoot } from "./listing.js";
import { resolve } from "node:path";

/**
 * Handles API requests. Currently supports:
 *   GET /api/listing[?path=relative/path] -> JSON array of entries (name, isDirectory).
 * Returns a Response-like object { status, body } for the caller to send.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/listing") {
    try {
      const relPath = url.searchParams.get("path") ?? "";
      const dir = resolve(repoRoot, relPath);
      // Guard against path traversal outside the repo root
      if (!dir.startsWith(repoRoot)) {
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

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}
