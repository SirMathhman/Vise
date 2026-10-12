import "../settings/settings-init.ts";
import { config } from "../config.ts";
import { missingBuildOutput } from "../build/build-check.ts";
import { runMaintenance } from "../build/maintenance.ts";
import {
  hideOwnConsole,
  logPath,
  logToFile,
  openWindow,
  showError,
  windowMode,
} from "./desktop/desktop.ts";
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
      let closeWindow = (): void => {};
      // Stop the server (waiting at most 5 s), then end the window thread so the event loop drains.
      const finish = (afterStop: () => void = () => {}): void => {
        const patience = new Promise((resolve) =>
          setTimeout(resolve, 5000).unref(),
        );
        void Promise.race([stop(), patience]).finally(() => {
          afterStop();
          closeWindow();
        });
      };
      closeWindow = openWindow(`http://localhost:${port}`, (event) => {
        if (event.type === "closed") finish();
        else if (event.type === "failed") {
          // With no window and no console the program would run unseen: say why and end.
          process.exitCode = 1;
          console.error("window failed:", event.reason);
          finish(() =>
            showError(
              "Vise could not open its window",
              `${event.reason}\n\nVise needs the Microsoft WebView2 runtime (included in Windows 11; for Windows 10 see https://developer.microsoft.com/microsoft-edge/webview2/).\nDetails: ${logPath}`,
            ),
          );
        }
      });
    }
  }
}
