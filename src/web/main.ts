import "../settings-init.ts";
import { config } from "../config.ts";
import { missingBuildOutput } from "../build-check.ts";
import { runMaintenance } from "../maintenance.ts";
import { hideOwnConsole, logToFile, openWindow, windowMode } from "./desktop.ts";
import { anyFreePort, busyPortNote, choosePort } from "./port.ts";

/**
 * Web frontend entry point. Starts the Bun HTTP + WebSocket server (unless a
 * maintenance flag was given) and, in the compiled build, Vise's own window;
 * closing the window ends the program.
 */
if (!(await runMaintenance())) {
  const windowed = windowMode();
  // No one watches a console in the desktop build: it is hidden and its output goes to the log.
  if (windowed) {
    hideOwnConsole();
    logToFile();
  }
  const missing = missingBuildOutput("web/dist/app.js", "bun run build:web");
  if (missing) {
    console.error(missing);
    process.exitCode = 1;
  } else {
    const { startWebServer } = await import("./server.ts");
    // A busy port never stops Vise: it moves to a free one and says so in the page.
    let { port, note } = await choosePort(config.port);
    let stop: () => Promise<void>;
    try {
      stop = startWebServer(port, note);
    } catch (error) {
      // Only a taken port is recovered from; anything else is a real error to see.
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
      // The port was taken between the check and the start: take any free one.
      port = await anyFreePort();
      note = busyPortNote(config.port, port);
      stop = startWebServer(port, note);
    }
    if (windowed) {
      const closeWindow = openWindow(`http://localhost:${port}`, () => {
        // The window was closed: shut down so the event loop drains and the program ends.
        void stop().finally(closeWindow);
      });
    }
  }
}
