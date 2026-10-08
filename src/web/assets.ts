// The page's files. `type: "file"` resolves to the file on disk when run from
// source and to the copy inside the executable when compiled. `web/dist/app.js`
// is built by `bun run build:web`, which must run before either.
import indexHtml from "../../web/index.html" with { type: "file" };
// @ts-expect-error TypeScript has no type for a CSS import; with `type: "file"` it is a path.
import stylesCss from "../../web/styles.css" with { type: "file" };
import appJs from "../../web/dist/app.js" with { type: "file" };

// Bun types HTML and JS imports as bundles; with `type: "file"` they are paths.
const path = (imported: unknown): string => imported as string;

/** The only files the server serves, by request path. */
export const WEB_ASSETS: Readonly<Record<string, { file: string; type: string }>> = {
  "/": { file: path(indexHtml), type: "text/html; charset=utf-8" },
  "/index.html": { file: path(indexHtml), type: "text/html; charset=utf-8" },
  "/styles.css": { file: path(stylesCss), type: "text/css; charset=utf-8" },
  "/dist/app.js": { file: path(appJs), type: "text/javascript; charset=utf-8" },
};

/** Serve one of the page's files, or a 404 for any other path. */
export async function serveAsset(path: string): Promise<Response> {
  const asset = Object.hasOwn(WEB_ASSETS, path) ? WEB_ASSETS[path] : undefined;
  if (!asset) return new Response("not found", { status: 404 });
  return new Response(await Bun.file(asset.file).arrayBuffer(), {
    headers: { "Content-Type": asset.type },
  });
}
