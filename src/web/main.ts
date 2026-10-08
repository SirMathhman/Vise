import "../settings-init.ts";
import { config } from "../config.ts";
import { runMaintenance } from "../maintenance.ts";

/** Web frontend entry point. Starts the Bun HTTP + WebSocket server (unless a maintenance flag was given). */
if (!(await runMaintenance())) {
  const { startWebServer } = await import("./server.ts");
  startWebServer(config.port);
}
