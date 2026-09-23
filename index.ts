// Entry point: build Config, construct the frontend transport, wire the
// REPL, run. The terminal transport is the swappable frontend (see
// src/transport.ts); a web UI or TUI would construct a different one and
// pass it here instead, so the core is shared across frontends.
import { loadConfig } from "./src/config.ts";
import { run } from "./src/repl/loop.ts";
import { createTerminalTransport } from "./src/repl/terminalTransport.ts";

const config = loadConfig();
const transport = createTerminalTransport();
await run(config, transport);
process.exit(0);
