import { config } from "../config.ts";
import { startWebServer } from "./server.ts";

/** Web frontend entry point. Starts the Bun HTTP + WebSocket server. */
startWebServer(config.port);
