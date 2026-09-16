import { createApp, createContext } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const rootPath =
  process.env.ROOT_DIR ?? "C:\\Users\\mathm\\Documents\\Projects\\Vise";
const app = createApp(createContext(rootPath));

void app.listen(port).then(() => {
  // eslint-disable-next-line no-console
  console.log(`[vise/backend] listening on http://localhost:${port}`);
});

// Clean shutdown: close the HTTP server and the app-owned file watcher so the
// process can exit. An open FSWatcher would otherwise keep the event loop
// alive and the process would hang after the signal.
const shutdown = (): void => {
  void app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
