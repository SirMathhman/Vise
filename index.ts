// Entry point: build Config, wire the REPL, run.
import { loadConfig } from "./src/config.ts";
import { run } from "./src/repl/loop.ts";

const config = loadConfig();
await run(config);
