import { startWebServer } from "./server.ts";

/** Web frontend entry point. Starts the Bun HTTP + WebSocket server. */
startWebServer(Number(process.env.PORT) || 3000);
