import "../settings-init.ts";
import { config } from "../config.ts";
import { missingBuildOutput } from "../build-check.ts";
import { runMaintenance } from "../maintenance.ts";
import { anyFreePort, busyPortNote, choosePort } from "./port.ts";

/** Web frontend entry point. Starts the Bun HTTP + WebSocket server (unless a maintenance flag was given). */
if (!(await runMaintenance())) {
  const missing = missingBuildOutput("web/dist/app.js", "bun run build:web");
  if (missing) {
    console.error(missing);
    process.exitCode = 1;
  } else {
    const { startWebServer } = await import("./server.ts");
    // A busy port never stops Vise: it moves to a free one and says so in the page.
    const chosen = await choosePort(config.port);
    try {
      startWebServer(chosen.port, chosen.note);
    } catch (error) {
      // Only a taken port is recovered from; anything else is a real error to see.
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
      // The port was taken between the check and the start: take any free one.
      const port = await anyFreePort();
      startWebServer(port, busyPortNote(config.port, port));
    }
  }
}
