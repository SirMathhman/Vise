import { config } from "../config.ts";
import type { ServerWebSocket } from "bun";
import { formatContext, formatError, formatGoalEvent } from "../output/format.ts";
import { formatWorkflowEvent } from "../output/workflow-format.ts";
import type { WorkflowEvent } from "../core/workflow.ts";
import { saveProfileWhitelist } from "../repl/profile-tools.ts";
import { BrowserSettingsStore } from "../browser/settings.ts";
import { ExtensionBackend } from "../browser/extension.ts";
import type { BrowserBackend } from "../browser/types.ts";
import { ExtensionHub, isExtensionOrigin } from "./ext/ext-hub.ts";
import { loadExtensionToken, tokensMatch } from "./ext/ext-token.ts";
import { handleEditorMessage } from "./api/editors.ts";
import { handleGitMessage } from "./api/git-api.ts";
import { createInspector } from "./inspect/inspect.ts";
import { serveAsset } from "./assets.ts";
import { queueLine, steerLine, unqueue } from "./conn/line.ts";
import type { HeldLine } from "./conn/line.ts";
import { isLocalHost, isLocalOrigin, serveApi } from "./http.ts";
import { createGate } from "./conn/gate.ts";
import { finishOpening } from "./conn/open.ts";
import { handleMcpMessage } from "./api/mcp-api.ts";
import { handleModelMessage } from "./api/models/model-api.ts";
import { handleSettingsMessage } from "./api/settings-api.ts";
import { handleQueueCommand } from "./conn/queue-commands.ts";
import { SessionLease } from "./conn/leases.ts";
import { SwitchableBrowser } from "../browser/switchable.ts";
import { BrowserBridge } from "./ext/browser-bridge.ts";
import { type HookStore } from "../edge-sources.ts";
import { dataDirFor, noFolderRoot } from "../data-dir.ts";
import type { McpHub } from "../mcp/mcp-hub.ts";
import { RootRegistry } from "./api/roots.ts";
import { createEdgeSession } from "../wiring.ts";
import { clipDetail, formatToolCall, summarizeToolResult } from "../output/tool-line.ts";
import { displayOfTool } from "../tools/display.ts";
import { WebUserPrompter } from "./conn/prompter.ts";
import { askToContinue } from "../tools/agent/ask-user.ts";
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
  const acquired = new Map<
    ServerWebSocket<WsData>,
    { store: HookStore; hub: McpHub }
  >();
  const gate = createGate<
    ServerWebSocket<WsData>,
    ConnectionState,
    string | Buffer<ArrayBuffer>
  >({
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
  /** The folder's MCP servers (shared by its pages). */
  mcp?: McpHub;
  /** Stops the project-tree watcher; set once the connection opens. */
  unwatch: () => void;
  /** The session's data directory (its notes live there). */
  dataDir: string;
  /** The saved sessions this connection works in (one connection at a time per session). */
  lease: SessionLease;
  /** This page's handle on its folder's shell; null with no folder or in the extension's sidebar. */
  terminal: TerminalAttachment | null;
  /** The page's live look at model calls (made when it first asks). */
  inspector?: ReturnType<typeof createInspector>;
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
    onSubagentToken: (t, depth) =>
      send({ type: "subagent_token", text: t, depth }),
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
  };
}

/** The `workflow` message for a run's progress: the step or end, the line to show, and (for a stopped run) the profile the session was left in. */
function workflowMessage(event: WorkflowEvent): Record<string, unknown> {
  const line = formatWorkflowEvent(event);
  const shown = line ? { text: line.text, level: line.level } : {};
  if (event.kind === "profile") return { type: "workflow", kind: "profile", profile: event.name ?? "", ...shown };
  const base = { type: "workflow", kind: event.kind, name: event.name, ...shown };
  if (event.kind === "start") return { ...base, total: event.total };
  if (event.kind === "step") return { ...base, step: event.index, total: event.total, label: event.label };
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

interface WireMessage {
  type: string;
  /** `inspect_start`: the model call to watch (the running one when absent). */
  request?: number;
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
  if (msg.type.startsWith("mcp_")) {
    // MCP server settings are read and written directly; never queued behind a turn.
    const wire = msg as unknown as Record<string, unknown>;
    void handleMcpMessage(conn.mcp, conn.ws.data.root, wire).then(send);
    return;
  }
  if (msg.type.startsWith("model_")) {
    // The model picker reads and writes the model list directly; never queued behind a turn.
    void handleModelMessage(conn.edge.modelPicker, msg as unknown as Record<string, unknown>).then(send);
    return;
  }
  if (msg.type.startsWith("inspect_")) {
    // The live look at model calls never queues behind a turn (the turn is what it watches).
    conn.inspector ??= createInspector(conn.edge.calls, send);
    conn.inspector.handle(msg);
    return;
  }
  if (msg.type.startsWith("git_")) {
    // The git panel runs git in the session's folder directly; never queued behind a turn.
    const { root, noFolder } = conn.ws.data;
    const wire = msg as unknown as Record<string, unknown>;
    for (const reply of handleGitMessage(root, noFolder, wire) ?? []) send(reply);
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
  if (
    msg.type.startsWith("note") ||
    msg.type.startsWith("workflow") ||
    msg.type.startsWith("profile")
  ) {
    // The notes, workflow and profile editors read and write their stores directly; never queued behind a turn.
    // (`profile_tools` is not theirs: it falls through to its own handler below.)
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
