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
import { handleSettingsMessage } from "./api/settings-api.ts";
import { handleQueueCommand } from "./conn/queue-commands.ts";
import { SessionLease } from "./conn/leases.ts";
import { queueAutoResume } from "./conn/resume.ts";
import { imageStore } from "../stores/image-store.ts";
import { SwitchableBrowser } from "../browser/switchable.ts";
import { BrowserBridge } from "./ext/browser-bridge.ts";
import { type HookStore } from "../edge-sources.ts";
import { dataDirFor, noFolderRoot } from "../data-dir.ts";
import { pickFolder, RootRegistry } from "./api/roots.ts";
import { createEdgeSession } from "../wiring.ts";
import { formatToolCall, summarizeToolResult } from "../output/tool-line.ts";
import { displayOfTool } from "../tools/display.ts";
import { listDir, readTextFile, deletePath, watchRoot, annotateIgnored, type DirEntry } from "./api/files.ts";
import { WebUserPrompter } from "./conn/prompter.ts";
import { TerminalRegistry, type TerminalAttachment } from "./terminal/terminal-registry.ts";
import { spawnConPty } from "./terminal/pty.ts";
import { handleTerminalMessage } from "./terminal/terminal-api.ts";

/**
 * Web frontend driver (the "frontend" seam, sibling to `TerminalDriver`).
 * Serves the static UI from `web/` and bridges the browser to the same
 * `Session` the terminal driver drives, over a WebSocket. It is a thin
 * adapter over the shared edge stack built by `createEdgeSession` (invariant
 * #2: edge owns I/O; invariant #4: edge → core only) — the conversation,
 * tools, and services are identical to the terminal's; only the transport
 * and the mid-turn user prompts differ.
 *
 * Each WebSocket connection gets its own `EdgeSession` (a fresh `Session`,
 * `LlmClient`, and data sources), so each browser tab is an independent
 * conversation. The display callbacks (`onToken`, etc.) and the `UserPrompter`
 * are captured in closure over that connection's socket, so no module-level
 * mutable "current socket" is needed and two tabs never interleave output.
 *
 * Wire protocol (JSON messages):
 *   browser → server: { type:"line", text }        a user line
 *                     { type:"ask_answer", text }   answer to an ask/max-rounds
 *                     { type:"interrupt" }          abort the in-flight turn
 *                     { type:"steer", text, images? } reach the agent before its next step
 *                     { type:"line", text, qid }    qid: hold until the work in flight is done (shown in the queue)
 *                     { type:"unqueue", qid }       remove a held line
 *                     { type:"term_open", cols, rows } show the folder's shell (started if none; else its output is replayed)
 *                     { type:"term_input", data }   keystrokes for the shell
 *                     { type:"term_resize", cols, rows } / { type:"term_restart" } / { type:"term_close" }
 *   server → browser: { type:"token", text }        a streamed reply token
 *                     { type:"thinking", text }     a streamed thinking token
 *                     { type:"progress", total, cache, processed, time_ms }
 *                     { type:"generating", request, purpose, tokens, done, text? } how much a model call has written so far (tool call text is not streamed); text names the tool being called
 *                     { type:"tool", name, depth?, text } a tool call began (text: icon, name and a short detail)
 *                     { type:"tool_result", name, depth, text? } a tool call finished (text: what it came to, e.g. "12 matches"); for run_subagent it closes the subagent's box
 *                     { type:"image", id, mime, label, bytes, width?, height? } a tool produced a picture (fetch it from /api/image/<id>)
 *                     { type:"history", name, entries } the folder's latest saved session was restored on connect (`src/web/conn/history.ts`)
 *                     { type:"result", ok:true, value, streamed?, compactionWarning? }
 *                     { type:"result", ok:false, error }
 *                     { type:"ask", question, options, multiSelect? }
 *                     { type:"line_started", text, qid? } a line's turn began (a held line leaves the queue)
 *                     { type:"state", running, steerable } a line is running (the page's busy state follows this alone)
 *                     { type:"queue", items:[{qid,text}] } the lines being held
 *                     { type:"notice", text }       a short system note for the chat log
 *                     { type:"fs_changed" }          something under the project root changed
 *                     { type:"term_data", data, replay? } shell output (replay: the screen so far; reset first)
 *                     { type:"term_exit", code }     the shell ended
 *                     { type:"term_error", message } the shell could not start
 *                     { type:"exit" }                the line was /exit
 */

/** Non-browser clients send no Origin; browsers must come from the Vise page itself. */
function isLocalOrigin(origin: string | null, port: number): boolean {
  return (
    origin === null ||
    origin === `http://localhost:${port}` ||
    origin === `http://127.0.0.1:${port}`
  );
}

function isLocalHost(host: string | null, port: number): boolean {
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

/** Track whether any reply tokens were streamed during a turn (the `streamed` flag). */
class WebDisplay {
  private streamed = false;
  reset(): void {
    this.streamed = false;
  }
  onToken(_text: string): void {
    this.streamed = true;
  }
  get wasStreamed(): boolean {
    return this.streamed;
  }
}

/** The JSON APIs the page uses (explorer, folder chooser, extension pairing); null when `url` is not one. */
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

function serveApi(
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

/**
 * Decide what a WebSocket upgrade carries, or refuse it. `/ext` is the Firefox
 * extension (only a `moz-extension://` page can send that Origin); `/ws` is a
 * chat session, whose root is fixed here, when the connection opens, and never
 * changes (`?root=none` is a session with no working directory at all).
 */
function socketData(
  url: URL,
  origin: string | null,
  port: number,
  roots: RootRegistry,
  extensionToken: string,
): WsData | Response {
  const refuse = new Response("forbidden", { status: 403 });
  if (url.pathname === "/ext") {
    // The extension's Origin is not enough (another extension could send it): it must also know the pairing token.
    if (!isExtensionOrigin(origin)) return refuse;
    if (!tokensMatch(url.searchParams.get("token"), extensionToken)) {
      return refuse;
    }
    return { ext: true, root: "", noFolder: false, sidebar: false };
  }
  // Browsers don't apply CORS to WebSockets: refuse other sites' pages.
  if (!isLocalOrigin(origin, port)) return refuse;
  // A page starts with no folder unless its address names one; a folder that is gone falls back to none.
  const param = url.searchParams.get("root");
  const named = param !== null && param !== "" && param !== "none";
  const dir = named ? roots.resolve(param) : null;
  const noFolder = dir === null;
  const root = dir ?? noFolderRoot;
  const badRoot = named && noFolder ? param : undefined;
  // `?ui=sidebar` is the page inside the Firefox extension: its browser is the user's own.
  const sidebar = url.searchParams.get("ui") === "sidebar";
  return { ext: false, root, noFolder, sidebar, badRoot };
}

/** Tells the page which folder its session is on (none, or one that was asked for but is gone). */
function rootMessage(data: WsData): Record<string, unknown> {
  return {
    type: "root",
    path: data.noFolder ? "" : data.root,
    noFolder: data.noFolder,
    badRoot: data.badRoot,
  };
}

/** Start the web driver: serve the UI and accept WebSocket connections. */
/** Show `note` in the page after the restored conversation, which replaces the chat log. */
function queueNote(conn: ConnectionState, note?: string): void {
  if (note)
    conn.chain = conn.chain.then(() =>
      conn.send({ type: "notice", text: note }),
    );
}

/** `note` is shown in each page that connects (e.g. that the wanted port was busy). */
export function startWebServer(
  port = config.port,
  note?: string,
): () => Promise<void> {
  // One browser shared by every connection; it launches on first tool use.
  // Its engine (Chromium or Firefox) is a global setting changed from the UI.
  const settingsStore = new BrowserSettingsStore();
  const browser = new SwitchableBrowser(settingsStore.load(), settingsStore);
  // Sessions are rooted where they were opened; the default is where the server started.
  const roots = new RootRegistry(process.cwd());
  // The Firefox extension's connection, and the browser sessions in its sidebar use.
  const extensionHub = new ExtensionHub();
  const extensionBrowser = new ExtensionBackend(extensionHub);
  const terminals = new TerminalRegistry(spawnConPty);
  const extensionToken = loadExtensionToken();
  const state = new Map<ServerWebSocket<WsData>, ConnectionState>();
  const server = Bun.serve<WsData>({
    port,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      // Loopback bind plus a Host allow-list blocks DNS-rebinding reads.
      if (!isLocalHost(req.headers.get("host"), port)) {
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname === "/ext" || url.pathname === "/ws") {
        const data = socketData(
          url,
          req.headers.get("origin"),
          port,
          roots,
          extensionToken,
        );
        if (data instanceof Response) return data;
        server.upgrade(req, { data });
        return;
      }
      const api = serveApi(req, url, port, roots, extensionToken);
      if (api) return api;
      return serveAsset(url.pathname);
    },
    websocket: {
      open(ws) {
        if (ws.data.ext) {
          extensionHub.attach(ws);
          return;
        }
        const { root, noFolder, sidebar } = ws.data;
        const hookStore = roots.acquire(root);
        const conn = makeConnectionState(
          ws,
          sidebar ? extensionBrowser : browser,
          hookStore,
          root,
          noFolder,
          sidebar ? undefined : browser,
        );
        conn.send(rootMessage(ws.data));
        conn.send({ type: "goal_state", enabled: conn.session.goalChecking() });
        // The shared browser's engine setting, for the settings panel.
        void conn.bridge.handle({ type: "browser_settings_get" });
        // Tell the browser's file explorer whenever the project tree changes.
        // Any connection's hook edit refreshes every open hooks panel.
        const offHooks = hookStore.onChange(() => void pushHooks(conn));
        const stopWatching = noFolder
          ? () => {}
          : watchRoot(root, () => conn.send({ type: "fs_changed" }));
        conn.unwatch = () => {
          stopWatching();
          offHooks();
          roots.release(root);
        };
        // One shell per folder, shared by its pages and kept across reloads.
        if (!noFolder && !sidebar) conn.terminal = terminals.attach(root, conn.send);
        queueAutoResume(conn);
        queueNote(conn, note);
        state.set(ws, conn);
      },
      message(ws, message) {
        if (ws.data.ext) {
          extensionHub.handleMessage(String(message));
          return;
        }
        const conn = state.get(ws);
        if (conn) handleMessage(conn, message);
      },
      close(ws) {
        if (ws.data.ext) {
          extensionHub.detach(ws);
          return;
        }
        closeConnection(state.get(ws));
        state.delete(ws);
      },
    },
  });
  console.log(`vise web: http://localhost:${port}`);
  // Closes the browser before the server stops, so it never outlives us.
  const shutdown = (): Promise<void> => {
    terminals.closeAll();
    return browser.close().finally(() => void server.stop(true));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.once(
      signal,
      () => void shutdown().finally(() => (process.exitCode = 130)),
    );
  }
  return shutdown;
}

/** What a WebSocket carries from the upgrade: the session root it was opened with. */
interface WsData {
  /** A folder the page asked for that is not available (it fell back to no folder). */
  badRoot?: string;
  /** The Firefox extension's own connection (`/ext`), not a chat session. */
  ext: boolean;
  /** A session in the extension's sidebar: it drives the user's real browser. */
  sidebar: boolean;
  root: string;
  /** No working directory: `root` is then only the generated store directory. */
  noFolder: boolean;
}

interface ConnectionState {
  ws: ServerWebSocket<WsData>;
  send: (msg: Record<string, unknown>) => void;
  prompter: WebUserPrompter;
  display: WebDisplay;
  session: ReturnType<typeof createEdgeSession>["session"];
  edge: ReturnType<typeof createEdgeSession>;
  chain: Promise<void>;
  held: HeldLine[];
  running: boolean;
  bridge: BrowserBridge;
  /** Stops the project-tree watcher; set once the connection opens. */
  unwatch: () => void;
  /** The session's data directory (its notes live there). */
  dataDir: string;
  /** The saved sessions this connection works in (one connection at a time per session). */
  lease: SessionLease;
  /** This page's handle on its folder's shell; null with no folder or in the extension's sidebar. */
  terminal: TerminalAttachment | null;
}

function makeConnectionState(
  ws: ServerWebSocket<WsData>,
  browser: BrowserBackend,
  hookStore: HookStore,
  root: string,
  noFolder: boolean,
  /** The shared headless browser, when this session uses it (enables the engine settings). */
  shared?: SwitchableBrowser,
): ConnectionState {
  const send = (msg: Record<string, unknown>): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg)); // readyState 1 = OPEN
  };
  const prompter = new WebUserPrompter(send);
  const display = new WebDisplay();
  const edge = createEdgeSession({
    browser,
    hookStore,
    root,
    noFolder,
    onToken: (t) => {
      display.onToken(t);
      send({ type: "token", text: t });
    },
    onThinking: (t) => send({ type: "thinking", text: t }),
    onPromptProgress: (p) =>
      send({
        type: "progress",
        total: p.total,
        cache: p.cache,
        processed: p.processed,
        time_ms: p.time_ms,
        request: p.request,
        purpose: p.purpose,
      }),
    onGenerating: (g) =>
      g.used !== undefined && g.max !== undefined
        ? send({ type: "context", purpose: g.purpose, text: formatContext(g.used, g.max) })
        : send({
        type: "generating",
        request: g.request,
        purpose: g.purpose,
        tokens: g.tokens,
        done: g.done,
        text: g.tool ? formatToolCall(g.tool, {}, displayOfTool) : undefined,
      }),
    onImage: (picture) => send({ type: "image", ...picture }),
    onToolCall: (name, depth, args) =>
      send({
        type: "tool",
        name,
        depth,
        text: formatToolCall(name, args, displayOfTool),
      }),
    onBurst: (active) => send({ type: "burst", active }),
    onTodos: (items) => send({ type: "todos", todos: items }),
    onGoal: (event) => {
      if (event.kind === "setting") {
        send({ type: "goal_state", enabled: event.enabled });
        return;
      }
      const line = formatGoalEvent(event);
      if (line) send({ type: "goal", ...line });
    },
    onSubagentToken: (t, depth) =>
      send({ type: "subagent_token", text: t, depth }),
    onToolResult: (name, depth, result) => {
      const text = summarizeToolResult(name, result);
      // A finished subagent always reports (it closes its box); other tools only when there is something to say.
      if (text !== undefined || name === "run_subagent")
        send({ type: "tool_result", name, depth, text });
    },
    askUser: prompter,
    onMaxRounds: async (question) => {
      const answer = await prompter.ask({
        question,
        options: ["Continue", "Stop"],
      });
      const a = answer.trim().toLowerCase();
      return a === "1" || a === "continue" || a === "yes" || a === "y";
    },
  });
  return {
    ws,
    send,
    prompter,
    display,
    session: edge.session,
    edge,
    chain: Promise.resolve(),
    held: [],
    running: false,
    bridge: new BrowserBridge(browser, send, shared),
    unwatch: () => {},
    dataDir: dataDirFor(root),
    lease: new SessionLease(root),
    terminal: null,
  };
}

/** Release everything a page's connection holds once its socket closes. */
function closeConnection(conn: ConnectionState | undefined): void {
  if (!conn) return;
  conn.unwatch();
  conn.terminal?.detach();
  conn.lease.release();
  conn.edge.cleanup();
  void conn.bridge.dispose();
  conn.session.interrupt();
  conn.prompter.settle("");
}

interface WireMessage {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  /** `profile_tools` write: the whitelist, or null for all tools. */
  tools?: string[] | null;
  /** `profile_tools`: read the current whitelist instead of writing one. */
  read?: boolean;
  /** `line`: pictures attached to the message (data URIs; checked by `acceptPictures`). */
  images?: unknown;
  /** `line`: the page's id for a message held until the work in flight is done; `unqueue`: the one to remove. */
  qid?: string;
  /** `env_set`: the settings page's values by variable name. */
  values?: Record<string, string>;
}

/**
 * Read or write a profile's tool whitelist. It writes only the profile file,
 * so it is instant, works while a turn is running, and never touches the
 * conversation history.
 */
async function handleProfileTools(
  conn: ConnectionState,
  msg: WireMessage,
): Promise<void> {
  const { edge, send } = conn;
  const name = msg.name ?? "";
  const reply = (fields: Record<string, unknown>): void =>
    send({ type: "profile_tools", id: msg.id, name, ...fields });
  const fail = (error: string): void => reply({ ok: false, error });
  const source = edge.profileSource;
  if (!source.profileTools) return fail("tool whitelists not supported");
  if (msg.read) {
    const current = await source.profileTools(name);
    if (!current.ok) return fail(formatError(current.error));
    return reply({ ok: true, tools: current.value ?? null });
  }
  const names = edge.toolController.list().map((t) => t.name);
  const saved = await saveProfileWhitelist(
    source,
    names,
    name,
    msg.tools ?? undefined,
  );
  if (!saved.ok) return fail(formatError(saved.error));
  reply({ ok: true, tools: saved.value ?? null });
}

/** Send the connection the global hooks and each profile's own hooks (a pure read; never queued behind a turn). */
async function pushHooks(conn: ConnectionState): Promise<void> {
  conn.send({ type: "hooks", ...(await conn.session.hooksView()) });
}

function handleMessage(
  conn: ConnectionState,
  message: string | Buffer<ArrayBuffer> | null,
): void {
  const { send, prompter, session } = conn;
  let msg: WireMessage;
  try {
    msg = JSON.parse(String(message));
  } catch {
    return;
  }
  if (msg.type.startsWith("browser_")) {
    // Browser view traffic never queues behind a model turn.
    void conn.bridge.handle(msg as unknown as Record<string, unknown>);
    return;
  }
  if (msg.type.startsWith("term_")) {
    // The integrated terminal never queues behind a model turn.
    handleTerminalMessage(conn.terminal, msg, send);
    return;
  }
  if (msg.type === "env_get" || msg.type === "env_set") {
    // Settings read and write the user-level settings file directly; never queued behind a turn.
    for (const reply of handleSettingsMessage(
      msg as unknown as Record<string, unknown>,
    ) ?? [])
      send(reply);
    return;
  }
  if (msg.type.startsWith("note") || msg.type.startsWith("workflow")) {
    // The notes and workflow editors read and write their stores directly; never queued behind a turn.
    const replies = handleEditorMessage(conn.dataDir, msg as never);
    for (const reply of replies ?? []) send(reply);
    if (replies) return;
  }
  if (msg.type === "hooks_get") {
    // A pure read of the live hook lists; never queued behind a model turn.
    void pushHooks(conn);
    return;
  }
  if (msg.type === "interrupt") {
    session.interrupt();
    return;
  }
  if (msg.type === "ask_answer") {
    prompter.settle(msg.text ?? "");
    return;
  }
  if (msg.type === "profile_tools") {
    // Straight to the profile file, never queued behind a model turn.
    void handleProfileTools(conn, msg);
    return;
  }
  if (typeof msg.text !== "string") {
    if (msg.type === "unqueue" && typeof msg.qid === "string") {
      unqueue(conn, msg.qid);
    }
    return;
  }
  if (msg.type === "steer") {
    steerLine(conn, msg.text, msg.images);
    return;
  }
  if (msg.type !== "line") return;
  if (handleQueueCommand(conn, msg.text)) return;
  queueLine(conn, msg.text, msg.id, msg.images, msg.qid);
}

export { startWebServer as default };
