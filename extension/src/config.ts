/** The Vise server's port: where the extension connects and what the sidebar embeds. */
export const DEFAULT_PORT = 3000;

/** The configured port (set on the options page), or the default. */
export async function getPort(): Promise<number> {
  const { port } = await browser.storage.local.get("port");
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : DEFAULT_PORT;
}
