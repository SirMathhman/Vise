import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleApi } from "./api.js";
import { serveFile } from "./static.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;
const WEB_DIST = join(__dirname, "..", "web", "dist");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res);
    return;
  }

  // Serve the built frontend. Fall back to index.html for SPA-style routes.
  if (existsSync(WEB_DIST)) {
    if (await serveFile(req, res, WEB_DIST, url.pathname)) return;
    if (await serveFile(req, res, WEB_DIST, "/index.html")) return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found. Build the frontend first: npm run build -w web");
});

server.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});
