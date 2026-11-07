import { fileURLToPath } from "node:url";
import { err, ok, type Result } from "../../core/result.ts";
import type { WebAssets } from "./server.ts";

// Builds the page from the client's files: the script is bundled, and the shell and style are read
// as they are. Called once at startup.
export async function buildAssets(): Promise<Result<WebAssets>> {
  const clientDir = new URL("../client/", import.meta.url);
  const built = await Bun.build({
    entrypoints: [fileURLToPath(new URL("main.ts", clientDir))],
    target: "browser",
    format: "esm",
    minify: true,
  });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    const messages = built.logs.map((log) => log.message).join("\n");
    return err(new Error(`the page script did not build: ${messages}`));
  }
  const html = await Bun.file(
    fileURLToPath(new URL("shell.html", clientDir)),
  ).text();
  const style = await Bun.file(
    fileURLToPath(new URL("style.css", clientDir)),
  ).text();
  return ok({ html, script: await output.text(), style });
}
