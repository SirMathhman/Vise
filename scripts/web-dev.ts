// Runs the browser server (bun run web) and restarts it when a file under src/ or index.ts changes.
// The page is bundled when the server starts, so a change to any file, client or server, takes effect
// after a restart. The session starts again with each restart. The script exits when the server does,
// and Ctrl+C stops the server.

import { watch } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";

const root = join(import.meta.dir, "..");
// Saves within this time of each other cause one restart.
const DEBOUNCE_MS = 200;

let server: Subprocess | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let queue: Promise<void> = Promise.resolve();

function start(): void {
  const proc = Bun.spawn(["bun", "run", "index.ts", "--web"], {
    cwd: root,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  });
  server = proc;
  // The server ended on its own, for example because the session ended in the browser.
  void proc.exited.then((code) => {
    if (server !== proc) return;
    server = undefined;
    process.exit(code);
  });
}

// Ends the server and waits until it has gone. On Windows the whole process tree is ended, so the
// background jobs it started end with it; elsewhere the server gets SIGINT and stops its jobs itself.
async function stop(): Promise<void> {
  const running = server;
  server = undefined;
  if (running === undefined) return;
  if (process.platform === "win32") {
    Bun.spawnSync(["taskkill", "/pid", String(running.pid), "/T", "/F"]);
  } else {
    running.kill("SIGINT");
  }
  await running.exited;
}

// Restarts run one after another, so a burst of saves cannot start two servers.
function restart(): void {
  queue = queue.then(async () => {
    await stop();
    console.log("web:dev: change detected, restarting the server");
    start();
  });
}

function schedule(): void {
  clearTimeout(timer);
  timer = setTimeout(restart, DEBOUNCE_MS);
}

watch(join(root, "src"), { recursive: true }, schedule);
watch(join(root, "index.ts"), schedule);

process.once("SIGINT", () => {
  clearTimeout(timer);
  void queue.then(stop).then(() => process.exit(130));
});

start();
