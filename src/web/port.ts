import { createServer } from "node:net";

/** Whether the web server could listen on `port` of the loopback address right now. */
export function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

/** A free port chosen by the system. */
export function anyFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/** The first free port above `taken` (up to 100 further on), or undefined. */
export async function suggestPort(
  taken: number,
  free: (port: number) => Promise<boolean> = isPortFree,
): Promise<number | undefined> {
  for (let port = taken + 1; port <= Math.min(taken + 100, 65535); port++) {
    if (await free(port)) return port;
  }
  return undefined;
}

/** Tell the user, in the page, that their port was busy and how to choose another. */
export function busyPortNote(wanted: number, using: number): string {
  return `Port ${wanted} was already in use, so Vise is running on port ${using}. To pick a port yourself, set it under settings → general → port and restart.`;
}

/**
 * The port to serve on. Starting must never fail because of a busy port, so
 * when `preferred` is taken the next free one is used (any free port the
 * system hands out, if none of the next 100 is free) and `note` says so.
 */
export async function choosePort(
  preferred: number,
  free: (port: number) => Promise<boolean> = isPortFree,
): Promise<{ port: number; note?: string }> {
  if (await free(preferred)) return { port: preferred };
  const port = (await suggestPort(preferred, free)) ?? (await anyFreePort());
  return { port, note: busyPortNote(preferred, port) };
}
