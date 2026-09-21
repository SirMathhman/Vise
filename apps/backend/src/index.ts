import { createApp, createContext } from "./app.js";

const port = Number(process.env.PORT ?? 3001);
const rootPath =
  process.env.ROOT_DIR ?? "C:\\Users\\mathm\\Documents\\Projects\\Vise";
const staticDir = process.env.VISE_STATIC_DIR ?? undefined;
const llmUpstream = process.env.LLM_UPSTREAM ?? "http://127.0.0.1:8080";
const app = createApp(createContext(rootPath, { staticDir, llmUpstream }));

void app.listen(port, "127.0.0.1").then(() => {
  // eslint-disable-next-line no-console
  console.log(`[vise/backend] listening on http://127.0.0.1:${port}`);
});

// Clean shutdown: close the HTTP server and the app-owned file watcher so the
// process can exit. An open FSWatcher would otherwise keep the event loop
// alive and the process would hang after the signal.
const shutdown = (): void => {
  void app.close().then(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
