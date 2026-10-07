import type { ServerWebSocket } from "bun";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { resolve } from "node:path";
import { formatCompactionFailure, formatError } from "../output/format.ts";
import type { AskRequest, UserPrompter } from "../tools/ask-user.ts";
import type { LineResult } from "../repl/session.ts";
import { saveProfileWhitelist } from "../repl/profile-tools.ts";
import type { BrowserBackend } from "../browser/types.ts";
import { ChromiumBackend } from "../browser/chromium.ts";
import { createEdgeSession } from "../wiring.ts";
import { listDir, readTextFile, watchRoot } from "./files.ts";

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
 *   server → browser: { type:"token", text }        a streamed reply token
 *                     { type:"thinking", text }     a streamed thinking token
 *                     { type:"progress", total, cache, processed, time_ms }
 *                     { type:"tool", name, depth? } a tool call began
 *                     { type:"result", ok:true, value, streamed?, compactionWarning? }
 *                     { type:"result", ok:false, error }
 *                     { type:"ask", question, options, multiSelect? }
 *                     { type:"fs_changed" }          something under the project root changed
 *                     { type:"exit" }                the line was /exit
 */

const WEB_DIR = resolve("web");
const WEB_DIST_DIR = join(WEB_DIR, "dist");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/** Serve a static file from `web/`. The root path serves `index.html`. */
function serveStatic(path: string): Response {
  const rel =
    path === "/" || path === "/index.html" ? "index.html" : path.slice(1);
  const root = rel.startsWith("dist/") ? WEB_DIST_DIR : WEB_DIR;
  const relativePath = rel.startsWith("dist/")
    ? rel.slice("dist/".length)
    : rel;
  const file = join(root, relativePath);
  if (!file.startsWith(WEB_DIR) || !readFileSync(file, "utf8")) {
    return new Response("not found", { status: 404 });
  }
  return new Response(readFileSync(file, "utf8"), {
    headers: {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
    },
  });
}

function isLocalHost(host: string | null, port: number): boolean {
  return host === `localhost:${port}` || host === `127.0.0.1:${port}`;
}

/** Read-only explorer API: `/api/fs?path=` lists a directory, `/api/file?path=` reads a file. */
function serveExplorer(url: URL): Response {
  const root = process.cwd();
  const rel = url.searchParams.get("path") ?? "";
  const result =
    url.pathname === "/api/fs" ? listDir(root, rel) : readTextFile(root, rel);
  if (!result.ok)
    return Response.json({ error: result.error }, { status: result.status });
  return Response.json(result.value);
}

/**
 * Edge implementation of UserPrompter over a WebSocket. When the model calls
 * `ask_user` (or the max-tool-rounds callback fires), it sends an `ask`
 * message to the browser and awaits the `ask_answer` reply. `ask_user` and
 * max-rounds never overlap within a turn, so a single pending slot is safe.
 */
class WebUserPrompter implements UserPrompter {
  private pending: ((answer: string) => void) | null = null;
  constructor(private readonly send: (msg: Record<string, unknown>) => void) {}

  ask({ question, options, multiSelect = false }: AskRequest): Promise<string> {
    this.send({ type: "ask", question, options, multiSelect });
    return new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  /** Resolve the pending ask with the user's reply; no-op when none is open. */
  settle(answer: string): void {
    if (this.pending) {
      const resolve = this.pending;
      this.pending = null;
      resolve(answer);
    }
  }
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

/** Start the web driver: serve the UI and accept WebSocket connections. */
export function startWebServer(port = 3000): void {
  // One browser shared by every connection; it launches on first tool use.
  const browser = new ChromiumBackend();
  const state = new Map<ServerWebSocket<unknown>, ConnectionState>();
  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    fetch(req, server) {
      const url = new URL(req.url);
      // Loopback bind plus a Host allow-list blocks DNS-rebinding reads.
      if (!isLocalHost(req.headers.get("host"), port)) {
        return new Response("forbidden", { status: 403 });
      }
      if (url.pathname === "/ws") {
        server.upgrade(req);
        return;
      }
      if (url.pathname === "/api/fs" || url.pathname === "/api/file") {
        return serveExplorer(url);
      }
      return serveStatic(url.pathname);
    },
    websocket: {
      open(ws) {
        const conn = makeConnectionState(ws, browser);
        // Tell the browser's file explorer whenever the project tree changes.
        conn.unwatch = watchRoot(process.cwd(), () =>
          conn.send({ type: "fs_changed" }),
        );
        state.set(ws, conn);
      },
      message(ws, message) {
        const conn = state.get(ws);
        if (!conn) return;
        handleMessage(conn, message);
      },
      close(ws) {
        const conn = state.get(ws);
        if (!conn) return;
        conn.unwatch();
        conn.session.interrupt();
        conn.prompter.settle("");
        state.delete(ws);
      },
    },
  });
  console.log(`vise web: http://localhost:${port}`);
  void server;
}

interface ConnectionState {
  ws: ServerWebSocket<unknown>;
  send: (msg: Record<string, unknown>) => void;
  prompter: WebUserPrompter;
  display: WebDisplay;
  session: ReturnType<typeof createEdgeSession>["session"];
  edge: ReturnType<typeof createEdgeSession>;
  chain: Promise<void>;
  /** Stops the project-tree watcher; set once the connection opens. */
  unwatch: () => void;
}

function makeConnectionState(
  ws: ServerWebSocket<unknown>,
  browser: BrowserBackend,
): ConnectionState {
  const send = (msg: Record<string, unknown>): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify(msg)); // readyState 1 = OPEN
  };
  const prompter = new WebUserPrompter(send);
  const display = new WebDisplay();
  const edge = createEdgeSession({
    browser,
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
      }),
    onToolCall: (name, depth) => send({ type: "tool", name, depth }),
    onBurst: (active) => send({ type: "burst", active }),
    onSubagentToken: (t) => send({ type: "subagent_token", text: t }),
    askUser: prompter,
    onMaxRounds: async () => {
      const answer = await prompter.ask({
        question: "Maximum tool rounds reached. Continue?",
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
    unwatch: () => {},
  };
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

function handleMessage(
  conn: ConnectionState,
  message: string | Buffer<ArrayBuffer> | null,
): void {
  const { send, prompter, display, session } = conn;
  let msg: WireMessage;
  try {
    msg = JSON.parse(String(message));
  } catch {
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
  if (msg.type !== "line" || typeof msg.text !== "string") return;
  conn.chain = conn.chain
    .then(() => handleLine(session, display, send, msg.text ?? "", msg.id))
    .catch((error: unknown) => {
      send({ type: "result", ok: false, error: String(error) });
    });
}

async function handleLine(
  session: ReturnType<typeof createEdgeSession>["session"],
  display: WebDisplay,
  send: (msg: Record<string, unknown>) => void,
  line: string,
  id?: string,
): Promise<void> {
  display.reset();
  const result: LineResult = await session.handleLine(line);
  if (result === "exit") {
    send({ type: "exit" });
    return;
  }
  if (result.ok) {
    // Read the live context fill after a successful turn so the client can
    // display it. "/context" is a pure read (no model call, no conversation
    // change), so this is safe to call inline.
    let context: string | undefined;
    const ctxResult = await session.handleLine("/context");
    if (ctxResult !== "exit" && ctxResult.ok) {
      context = ctxResult.value;
    }
    send({
      type: "result",
      ok: true,
      value: result.value,
      ...(id === undefined ? {} : { id }),
      streamed: display.wasStreamed,
      context,
      ...(result.compactionWarning
        ? {
            compactionWarning: formatCompactionFailure(
              result.compactionWarning,
            ),
          }
        : {}),
    });
  } else {
    send({
      type: "result",
      ok: false,
      error: formatError(result.error),
      ...(id === undefined ? {} : { id }),
    });
  }
}

export { startWebServer as default };
