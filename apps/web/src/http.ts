import { imageStore } from "@vise/backend";
import { pickFolder, RootRegistry } from "./api/roots.ts";
import { listDir, readTextFile, deletePath, createPath, annotateIgnored, annotateGitStatus, type DirEntry } from "./api/files.ts";

/** Non-browser clients send no Origin; browsers must come from the Vise page itself. */
export function isLocalOrigin(origin: string | null, port: number): boolean {
  return (
    origin === null ||
    origin === `http://localhost:${port}` ||
    origin === `http://127.0.0.1:${port}`
  );
}

export function isLocalHost(host: string | null, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

/**
 * Run `act` for the session root the page named, relative path and all: only a
 * root with an open session is served, and a failed result is its status code.
 */
function withRoot(
  url: URL,
  roots: RootRegistry,
  act: (root: string, rel: string) => { ok: true; value: unknown } | { ok: false; error: string; status: number },
): Response {
  const root = roots.resolve(url.searchParams.get("root"));
  if (!root || !roots.isActive(root)) {
    return Response.json({ error: "unknown root" }, { status: 403 });
  }
  const result = act(root, url.searchParams.get("path") ?? "");
  if (!result.ok) return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result.value);
}

/** The explorer API: `/api/fs?path=` lists a directory, `/api/file?path=` reads a file (both take the session `root`). */
function serveExplorer(url: URL, roots: RootRegistry): Response {
  const listing = url.pathname === "/api/fs";
  return withRoot(url, roots, (root, rel) => {
    if (!listing) return readTextFile(root, rel);
    const result = listDir(root, rel);
    if (!result.ok) return result;
    const value = result.value as { root: string; entries: DirEntry[] };
    value.entries = annotateGitStatus(root, rel, annotateIgnored(root, rel, value.entries));
    return { ok: true, value };
  });
}

/** A stored picture by id (`/api/image/<sha256>`), for the page's thumbnails. Only the Vise page may load it. */
function serveImage(url: URL, req: Request): Response {
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") {
    return new Response("forbidden", { status: 403 });
  }
  const found = imageStore.find(url.pathname.slice("/api/image/".length));
  if (!found) return new Response("not found", { status: 404 });
  return new Response(new Uint8Array(found.bytes), {
    headers: {
      "content-type": found.mime,
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    },
  });
}

/** The JSON APIs the page uses (explorer, folder chooser, extension pairing); null when `url` is not one. */
export function serveApi(
  req: Request,
  url: URL,
  port: number,
  roots: RootRegistry,
  extensionToken: string,
): Response | Promise<Response> | null {
  if (url.pathname === "/api/ext-token" && req.method === "POST") {
    // Only the Vise page itself may read the pairing token. It must be a POST: browsers send no
    // Origin on a same-origin GET, but always send one on a POST.
    const origin = req.headers.get("origin");
    if (origin === null || !isLocalOrigin(origin, port)) {
      return new Response("forbidden", { status: 403 });
    }
    return Response.json({ token: extensionToken });
  }
  if (url.pathname === "/api/vise-hello") {
    // Lets the Firefox extension find the server when it had to move to another port.
    return Response.json({ vise: true });
  }
  if (url.pathname.startsWith("/api/image/")) return serveImage(url, req);
  if (url.pathname === "/api/fs" || url.pathname === "/api/file") {
    return serveExplorer(url, roots);
  }
  if (url.pathname === "/api/delete" && req.method === "POST") {
    return withRoot(url, roots, (root, rel) => {
      const result = deletePath(root, rel);
      return result.ok ? { ok: true, value: { ok: true } } : result;
    });
  }
  if (url.pathname === "/api/create" && req.method === "POST") {
    const isDir = url.searchParams.get("dir") === "1";
    return withRoot(url, roots, (root, rel) => {
      const result = createPath(root, rel, isDir);
      return result.ok ? { ok: true, value: { ok: true } } : result;
    });
  }
  if (url.pathname === "/api/pick-folder" && req.method === "POST") {
    // Opens the OS folder dialog; only the Vise page itself may ask.
    if (!isLocalOrigin(req.headers.get("origin"), port)) {
      return new Response("forbidden", { status: 403 });
    }
    return pickFolder(roots.defaultRoot).then((path) =>
      Response.json({ path }),
    );
  }
  return null;
}
