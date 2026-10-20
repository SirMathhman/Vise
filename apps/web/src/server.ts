import type { ServerWebSocket } from "bun";
import type { WorkflowEvent } from "@vise/core";
import {
  config,
  formatContext,
  formatGoalEvent,
  formatWorkflowEvent,
  BrowserSettingsStore,
  ExtensionBackend,
  SwitchableBrowser,
  HookStore,
  dataDirFor,
  noFolderRoot,
  createEdgeSession,
  clipDetail,
  formatToolCall,
  summarizeToolResult,
  displayOfTool,
  askToContinue,
  McpHub,
  type BrowserBackend,
} from "@vise/backend";
import { ExtensionHub, isExtensionOrigin } from "./ext/ext-hub.ts";
import { loadExtensionToken, tokensMatch } from "./ext/ext-token.ts";
import { serveAsset } from "./assets.ts";
import { isLocalHost, isLocalOrigin, serveApi } from "./http.ts";
import { createGate } from "./conn/gate.ts";
import { finishOpening } from "./conn/open.ts";
import { SessionLease } from "./conn/leases.ts";
import { BrowserBridge } from "./ext/browser-bridge.ts";
import { RootRegistry } from "./api/roots.ts";
import { WebUserPrompter } from "./conn/prompter.ts";
import { TerminalRegistry } from "./terminal/terminal-registry.ts";
import { spawnConPty } from "./terminal/pty.ts";
import { sendLists } from "./api/wire/lists.ts";
import { handleMessage, pushHooks } from "./router/router.ts";
import type { ConnectionState } from "./router/connection.ts";

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
 * Wire protocol (JSON messages). Where each type from the page goes is the table in
 * `router/router.ts`; the API modules under `api/` document their own messages (notes,
 * profiles, workflows, mcp, models, git, settings, lists). The core of it:
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

/** Track whether any reply tokens were streamed during a turn (the `streamed` flag). */
export class WebDisplay {
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
/** What a page's connection is built from. */
interface GateEnvironment {
  roots: RootRegistry;
  browser: SwitchableBrowser;
  extensionBrowser: BrowserBackend;
  terminals: TerminalRegistry;
  note?: string;
}

/** The gate that opens each page's connection once its folder's MCP servers are ready. */
function createConnectionGate(env: GateEnvironment) {
  const { roots, browser, extensionBrowser, terminals, note } = env;
  const acquired = new Map<ServerWebSocket<WsData>, { store: HookStore; hub: McpHub }>();
  const gate = createGate<ServerWebSocket<WsData>, ConnectionState, string | Buffer<ArrayBuffer>>({
    // The folder's MCP servers must be up before the session exists (its tool
    // list is fixed for the conversation); the gate holds messages meanwhile.
    start: (ws) => {
      const entry = roots.acquire(ws.data.root);
      acquired.set(ws, entry);
      return entry.hub.start();
    },
    open: (ws) => {
      const { store, hub } = acquired.get(ws)!;
      acquired.delete(ws);
      const { root, noFolder, sidebar } = ws.data;
      const conn = makeConnectionState(
        ws,
        sidebar ? extensionBrowser : browser,
        store,
        root,
        noFolder,
        sidebar ? undefined : browser,
        hub,
      );
      finishOpening(conn, {
        root,
        noFolder,
        sidebar,
        rootMessage: rootMessage(ws.data),
        hookStore: store,
        hub,
        terminals,
        releaseRoot: () => roots.release(root),
        pushHooks: () => void pushHooks(conn),
        semantic: conn.edge.semantic,
        note,
      });
      return conn;
    },
    handle: handleMessage,
    teardown: closeConnection,
    abandon: (ws) => {
      if (acquired.delete(ws)) roots.release(ws.data.root);
    },
    fail: (ws, error) => {
      console.error("vise web: could not open a connection:", error);
      ws.close(1011, "could not start the session");
    },
  });
  return gate;
}

/** `note` is shown in each page that connects (e.g. that the wanted port was busy). */
export function startWebServer(port = config.port, note?: string): () => Promise<void> {
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
  const gate = createConnectionGate({
    roots,
    browser,
    extensionBrowser,
    terminals,
    note,
  });
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
        const data = socketData(url, req.headers.get("origin"), port, roots, extensionToken);
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
        if (ws.data.ext) extensionHub.attach(ws);
        else gate.open(ws);
      },
      message(ws, message) {
        if (ws.data.ext) extensionHub.handleMessage(String(message));
        else gate.message(ws, message);
      },
      close(ws) {
        if (ws.data.ext) extensionHub.detach(ws);
        else gate.close(ws);
      },
    },
  });
  console.log(`vise web: http://localhost:${port}`);
  // Closes the browser before the server stops, so it never outlives us.
  const shutdown = (): Promise<void> => {
    terminals.closeAll();
    return Promise.all([browser.close(), roots.closeAll()])
      .then(() => undefined)
      .finally(() => void server.stop(true));
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"] as const) {
    process.once(signal, () => void shutdown().finally(() => (process.exitCode = 130)));
  }
  return shutdown;
}

/** What a WebSocket carries from the upgrade: the session root it was opened with. */
export interface WsData {
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

function makeConnectionState(
  ws: ServerWebSocket<WsData>,
  browser: BrowserBackend,
  hookStore: HookStore,
  root: string,
  noFolder: boolean,
  /** The shared headless browser, when this session uses it (enables the engine settings). */
  shared?: SwitchableBrowser,
  mcp?: McpHub,
): ConnectionState {
  const send = (msg: Record<string, unknown>): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg)); // readyState 1 = OPEN
  };
  const prompter = new WebUserPrompter(send);
  const display = new WebDisplay();
  const edge = createEdgeSession({
    surface: "web",
    browser,
    hookStore,
    root,
    noFolder,
    mcp,
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
        // The arguments as sent, for the line's details (clipped: a written file can be long).
        detail: clipDetail(JSON.stringify(args, null, 2)),
      }),
    onBurst: (active) => send({ type: "burst", active }),
    onTodos: (items) => send({ type: "todos", todos: items }),
    onGoal: (event) => {
      if (event.kind === "setting") return send({ type: "goal_state", enabled: event.enabled });
      const line = formatGoalEvent(event);
      if (line) send({ type: "goal", ...line });
    },
    onWorkflow: (event) => send(workflowMessage(event)),
    onSubagentToken: (t, depth) => send({ type: "subagent_token", text: t, depth }),
    onToolResult: (name, depth, result) => {
      const text = summarizeToolResult(name, result);
      // A finished subagent always reports (it closes its box); other tools when there is a summary or a result to show.
      if (text !== undefined || result !== "" || name === "run_subagent")
        send({ type: "tool_result", name, depth, text, detail: clipDetail(result) });
    },
    askUser: prompter,
    onMaxRounds: (question) => askToContinue(prompter, question),
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
    mcp,
    unwatch: () => {},
    dataDir: dataDirFor(root),
    lease: new SessionLease(root),
    terminal: null,
    lists: () => sendLists(edge, send),
  };
}

/** The `workflow` message for a run's progress: the step or end, the line to show, and (for a stopped run) the profile the session was left in. */
export function workflowMessage(event: WorkflowEvent): Record<string, unknown> {
  const line = formatWorkflowEvent(event);
  const shown = line ? { text: line.text, level: line.level } : {};
  if (event.kind === "profile")
    return { type: "workflow", kind: "profile", profile: event.name ?? "", ...shown };
  const base = { type: "workflow", kind: event.kind, name: event.name, ...shown };
  if (event.kind === "start") return { ...base, total: event.total };
  if (event.kind === "step")
    return { ...base, step: event.index, total: event.total, label: event.label };
  return { ...base, step: event.step, total: event.total, ok: !event.error };
}

/** Release everything a page's connection holds once its socket closes. */
function closeConnection(conn: ConnectionState | undefined): void {
  if (!conn) return;
  conn.unwatch();
  conn.inspector?.dispose();
  conn.terminal?.detach();
  conn.lease.release();
  conn.edge.cleanup();
  void conn.bridge.dispose();
  conn.session.interrupt();
  conn.prompter.settle("");
}

export { startWebServer as default };
