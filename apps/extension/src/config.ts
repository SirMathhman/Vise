declare const __VISE_BUILD__: string | undefined;

/** Identifies the build all of the extension's scripts came from ("dev" when unstamped). */
export const BUILD =
  typeof __VISE_BUILD__ === "string" ? __VISE_BUILD__ : "dev";

declare const __VISE_PORT__: number | undefined;

/**
 * The Vise server's port: where the extension connects and what the sidebar
 * embeds. 3000, unless a build (a test build) bakes in another with `define`.
 */
export const DEFAULT_PORT =
  typeof __VISE_PORT__ === "number" ? __VISE_PORT__ : 3000;

declare const __VISE_TOKEN__: string | undefined;

/** The pairing token the sidebar received from Vise, or a test build's baked-in one. */
export async function getToken(): Promise<string | null> {
  const { token } = await browser.storage.local.get("token");
  if (typeof token === "string" && token !== "") return token;
  return typeof __VISE_TOKEN__ === "string" ? __VISE_TOKEN__ : null;
}

/** The configured port (set on the options page), or the default. */
export async function getPort(): Promise<number> {
  const { port } = await browser.storage.local.get("port");
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}

/** How many ports above the default the extension looks through for a Vise server that had to move. */
const SCAN_RANGE = 100;

async function isVise(port: number): Promise<boolean> {
  try {
    const reply = await fetch(`http://127.0.0.1:${port}/api/vise-hello`, {
      signal: AbortSignal.timeout(1000),
    });
    return ((await reply.json()) as { vise?: boolean }).vise === true;
  } catch {
    return false;
  }
}

/**
 * Where the Vise server is: the configured port if a Vise answers there,
 * otherwise the first one of the next 100 above it that does (the server moves
 * to a free port when its own is busy), otherwise the configured port, so the
 * error names a port the user can act on.
 */
export async function findServerPort(): Promise<number> {
  const preferred = await getPort();
  if (await isVise(preferred)) return preferred;
  const ports = Array.from({ length: SCAN_RANGE + 1 }, (_, i) => preferred + i);
  const answers = await Promise.all(
    ports.map(async (port) =>
      port !== preferred && port <= 65535 && (await isVise(port)) ? port : 0,
    ),
  );
  return answers.find((port) => port > 0) ?? preferred;
}
