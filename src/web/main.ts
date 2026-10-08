import "../settings-init.ts";
import { config } from "../config.ts";
import { missingBuildOutput } from "../build-check.ts";
import { runMaintenance } from "../maintenance.ts";

/** Web frontend entry point. Starts the Bun HTTP + WebSocket server (unless a maintenance flag was given). */
if (!(await runMaintenance())) {
  const missing = missingBuildOutput("web/dist/app.js", "bun run build:web");
  if (missing) {
    console.error(missing);
    process.exitCode = 1;
  } else {
    const { startWebServer } = await import("./server.ts");
    startWebServer(config.port);
  }
}
