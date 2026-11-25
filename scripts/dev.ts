// Starts the backend and frontend dev servers after stopping any process
// already listening on their ports, so a stale dev server never blocks startup
// or keeps serving old code.

const BACKEND_PORT = Number(process.env.PORT ?? 3000);
const FRONTEND_PORT = 5173;
const PORTS = [BACKEND_PORT, FRONTEND_PORT];

async function run(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// Returns the PIDs of processes in LISTEN state on the given TCP port.
async function listeningPids(port: number): Promise<number[]> {
  if (process.platform === "win32") {
    const out = await run(["netstat", "-ano", "-p", "TCP"]);
    const pids = new Set<number>();
    for (const line of out.split(/\r?\n/)) {
      const m = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/.exec(line);
      if (m && Number(m[1]) === port) {
        pids.add(Number(m[2]));
      }
    }
    return [...pids];
  }

  const out = await run(["lsof", "-ti", `tcp:${String(port)}`, "-sTCP:LISTEN"]);
  return out
    .split(/\s+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0);
}

async function stopExistingDevServers(): Promise<void> {
  const ownPid = process.pid;
  for (const port of PORTS) {
    const pids = (await listeningPids(port)).filter((pid) => pid !== ownPid);
    for (const pid of pids) {
      try {
        process.kill(pid);
        console.log(
          `dev: stopped process ${String(pid)} on port ${String(port)}`,
        );
      } catch (err) {
        console.warn(
          `dev: could not stop process ${String(pid)} on port ${String(port)}: ${String(err)}`,
        );
      }
    }
  }
}

await stopExistingDevServers();

const child = Bun.spawn(
  [
    process.execPath,
    "run",
    "--parallel",
    "--filter",
    "backend",
    "--filter",
    "frontend",
    "dev",
  ],
  { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
);

// Forward Ctrl+C so both dev servers shut down together.
process.on("SIGINT", () => {
  child.kill("SIGINT");
});
process.on("SIGTERM", () => {
  child.kill("SIGTERM");
});

process.exitCode = await child.exited;
