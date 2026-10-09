import { config } from "../config.ts";
import type { ServerWebSocket } from "bun";
import { formatContext, formatError, formatGoalEvent } from "../output/format.ts";
import { saveProfileWhitelist } from "../repl/profile-tools.ts";
import { BrowserSettingsStore } from "../browser/settings.ts";
import { ExtensionBackend } from "../browser/extension.ts";
import type { BrowserBackend } from "../browser/types.ts";
import { ExtensionHub, isExtensionOrigin } from "./ext/ext-hub.ts";
import { loadExtensionToken, tokensMatch } from "./ext/ext-token.ts";
import { handleEditorMessage } from "./api/editors.ts";
import { serveAsset } from "./assets.ts";
import { queueLine, steerLine, unqueue } from "./conn/line.ts";
import type { HeldLine } from "./conn/line.ts";
import { createGate } from "./conn/gate.ts";
import { finishOpening } from "./conn/open.ts";
import { handleMcpMessage } from "./api/mcp-api.ts";
import { handleSettingsMessage } from "./api/settings-api.ts";
import { handleQueueCommand } from "./conn/queue-commands.ts";
import { SessionLease } from "./conn/leases.ts";
import { imageStore } from "../stores/image-store.ts";
import { SwitchableBrowser } from "../browser/switchable.ts";
import { BrowserBridge } from "./ext/browser-bridge.ts";
import { type HookStore } from "../edge-sources.ts";
import { dataDirFor, noFolderRoot } from "../data-dir.ts";
import type { McpHub } from "../mcp/mcp-hub.ts";
import { pickFolder, RootRegistry } from "./api/roots.ts";
import { createEdgeSession } from "../wiring.ts";
import { formatToolCall, summarizeToolResult } from "../output/tool-line.ts";
import { displayOfTool } from "../tools/display.ts";
import { listDir, readTextFile, deletePath, annotateIgnored, type DirEntry } from "./api/files.ts";
import { WebUserPrompter } from "./conn/prompter.ts";
import { TerminalRegistry, type TerminalAttachment } from "./terminal/terminal-registry.ts";
import { spawnConPty } from "./terminal/pty.ts";
import { handleTerminalMessage } from "./terminal/terminal-api.ts";

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

/** Read-only explorer API: `/api/fs?path=` lists a directory, `/api/file?path=` reads a file (both take the session `root`). */
function serveExplorer(url: URL, roots: RootRegistry): Response {
  // The session root the page was opened with; only roots in use are served.
  const root = roots.resolve(url.searchParams.get("root"));
  if (!root || !roots.isActive(root)) {
    return Response.json({ error: "unknown root" }, { status: 403 });
  }
  const rel = url.searchParams.get("path") ?? "";
  const result =
    url.pathname === "/api/fs" ? listDir(root, rel) : readTextFile(root, rel);
  if (!result.ok)
    return Response.json({ error: result.error }, { status: result.status });
  if (url.pathname === "/api/fs") {
    const value = result.value as { root: string; entries: DirEntry[] };
    value.entries = annotateIgnored(root, rel, value.entries);
    return Response.json(value);
  }
  return Response.json(result.value);
}

/** A stored picture by id (`/api/image/<sha256>`), for the page's thumbnails. Only the Vise page may load it. */
function serveImage(url: URL, port: number, req: Request): Response {
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
  if (url.pathname.startsWith("/api/image/")) return serveImage(url, port, req);
  if (url.pathname === "/api/fs" || url.pathname === "/api/file") {
    return serveExplorer(url, roots);
  }
  if (url.pathname === "/api/delete" && req.method === "POST") {
    const root = roots.resolve(url.searchParams.get("root"));
    if (!root || !roots.isActive(root)) {
      return Response.json({ error: "unknown root" }, { status: 403 });
    }
    const rel = url.searchParams.get("path") ?? "";
    const result = deletePath(root, rel);
    if (!result.ok)
      return Response.json({ error: result.error }, { status: result.status });
    return Response.json({ ok: true });
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
