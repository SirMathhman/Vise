declare const __VISE_PORT__: number | undefined;

/**
 * The Vise server's port: where the extension connects and what the sidebar
 * embeds. 3000, unless a build (a test build) bakes in another with `define`.
 */
export const DEFAULT_PORT =
  typeof __VISE_PORT__ === "number" ? __VISE_PORT__ : 3000;

/** The configured port (set on the options page), or the default. */
export async function getPort(): Promise<number> {
  const { port } = await browser.storage.local.get("port");
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}
