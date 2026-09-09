import { getListing } from "./listing.js";

/**
 * Handles API requests. Currently supports:
 *   GET /api/listing -> JSON array of top-level entry names in the CWD.
 * Returns a Response-like object { status, body } for the caller to send.
 */
export async function handleApi(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/api/listing") {
    try {
      const names = await getListing();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(names));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
}
