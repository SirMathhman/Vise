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
