// Runs the backend and frontend dev servers concurrently.
// `npm run dev --workspaces` runs workspaces sequentially, so the first
// long-running process (vite) blocks the second (node --watch) forever.
// This script spawns both and forwards their output, with Ctrl+C handling.

import { spawn } from "node:child_process";

const isWindows = process.platform === "win32";

// On Windows, npm is a .cmd shim and can only be spawned through a shell.
// Passing a single command string (not an args array) avoids Node's
// DEP0190 warning about unescaped args combined with `shell: true`.
const run = (command) =>
  isWindows
    ? spawn(command, { stdio: "inherit", shell: true })
    : spawn(command, { stdio: "inherit", shell: false });

const procs = [
  run("npm run dev -w apps/server"),
  run("npm run dev -w apps/web"),
];

function shutdown() {
  for (const proc of procs) {
    if (!proc.killed) proc.kill();
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    shutdown();
    process.exit(0);
  });
}

// If one process dies, stop the other too so we never leave orphans.
for (const proc of procs) {
  proc.on("exit", (code) => {
    if (code !== null && code !== 0) {
      console.error(`A dev process exited with code ${code}; shutting down.`);
      shutdown();
      process.exit(code);
    }
  });
}
