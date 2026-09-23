// Web entry point: build Config, start the web server, and exit when the
// active session ends. Mirrors index.ts but hands the core its web frontend:
// Bun.serve serves the static client (web/) and a WebSocket upgrade runs
// run(config, transport) for the single active session (see
// src/web/server.ts). The process exits when run() returns (WS closes ->
// transport.close() -> loop breaks), mirroring the terminal "Bye." semantics.
import { loadConfig } from "./src/config.ts";
import { createWebServer } from "./src/web/server.ts";

const config = loadConfig();
await createWebServer(config);
process.exit(0);
