import { formatError } from "@vise/backend";
import { saveProfileWhitelist } from "@vise/backend";
import { handleEditorMessage } from "../api/editors.ts";
import { handleGitMessage } from "../api/git-api.ts";
import { handleMcpMessage } from "../api/mcp-api.ts";
import { handleModelMessage } from "../api/models/model-api.ts";
import { handleEnvChoices, handleSettingsMessage } from "../api/settings-api.ts";
import { queueLine, steerLine, unqueue } from "../conn/line.ts";
import { handleSemanticMessage } from "../api/semantic/semantic-api.ts";
import { sendLists } from "../api/wire/lists.ts";
import { handleQueueCommand } from "../conn/queue-commands.ts";
import { createInspector } from "../inspect/inspect.ts";
import { handleTerminalMessage } from "../terminal/terminal-api.ts";
import type { ConnectionState, WireMessage } from "./connection.ts";

/**
 * Where each message type from the page goes. One table, one shape: a route
 * says which types it owns and what handles them. Everything here is answered
 * at once and never queued behind a model turn, except the `line` family at
 * the end (which is what the turn queue is for). Exact types are listed before
 * the prefixes that would also match them.
 */
type Handler = (conn: ConnectionState, msg: WireMessage) => void | Promise<void>;

interface Route {
  owns: (type: string) => boolean;
  run: Handler;
}

const prefix = (start: string) => (type: string) => type.startsWith(start);
const exact = (...types: string[]) => (type: string) => types.includes(type);

/** The message as the plain record the API handlers take. */
const record = (msg: WireMessage): Record<string, unknown> => msg as unknown as Record<string, unknown>;

/** Send every reply an API handler produced (it answers undefined for a message that is not its own). */
function sendAll(conn: ConnectionState, replies: Record<string, unknown>[] | null | undefined): void {
  for (const reply of replies ?? []) conn.send(reply);
}

/**
 * Read or write a profile's tool whitelist. It writes only the profile file,
 * so it is instant, works while a turn is running, and never touches the
 * conversation history.
 */
async function handleProfileTools(conn: ConnectionState, msg: WireMessage): Promise<void> {
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
  const saved = await saveProfileWhitelist(source, names, name, msg.tools ?? undefined);
  if (!saved.ok) return fail(formatError(saved.error));
  reply({ ok: true, tools: saved.value ?? null });
}

/** Send the connection the global hooks and each profile's own hooks (a pure read; never queued behind a turn). */
export async function pushHooks(conn: ConnectionState): Promise<void> {
  conn.send({ type: "hooks", ...(await conn.session.hooksView()) });
}

/** A `line` or `steer` carries text; `unqueue` carries the id of the held line to drop. */
function handleLineFamily(conn: ConnectionState, msg: WireMessage): void {
  if (typeof msg.text !== "string") {
    if (msg.type === "unqueue" && typeof msg.qid === "string") unqueue(conn, msg.qid);
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

const ROUTES: Route[] = [
  { owns: exact("profile_tools"), run: handleProfileTools },
  // Browser view traffic.
  { owns: prefix("browser_"), run: (conn, msg) => void conn.bridge.handle(record(msg)) },
  // The integrated terminal.
  { owns: prefix("term_"), run: (conn, msg) => handleTerminalMessage(conn.terminal, msg, conn.send) },
  // MCP server settings.
  {
    owns: prefix("mcp_"),
    run: async (conn, msg) => conn.send(await handleMcpMessage(conn.mcp, conn.ws.data.root, record(msg))),
  },
  // The model picker's list and switch.
  {
    owns: prefix("model_"),
    run: async (conn, msg) => conn.send(await handleModelMessage(conn.edge.modelPicker, record(msg))),
  },
  // The live look at model calls (the turn is what it watches, so it must not wait for it).
  {
    owns: prefix("inspect_"),
    run: (conn, msg) => {
      conn.inspector ??= createInspector(conn.edge.calls, conn.send);
      conn.inspector.handle(msg);
    },
  },
  // The git panel, run in the session's folder.
  {
    owns: prefix("git_"),
    run: (conn, msg) => {
      const { root, noFolder } = conn.ws.data;
      sendAll(conn, handleGitMessage(root, noFolder, record(msg)));
    },
  },
  // The settings file.
  { owns: exact("env_choices"), run: async (conn, msg) => sendAll(conn, await handleEnvChoices(record(msg))) },
  { owns: exact("env_get", "env_set"), run: (conn, msg) => sendAll(conn, handleSettingsMessage(record(msg))) },
  // The notes, workflow and profile editors read and write their stores directly.
  {
    owns: (type) => type.startsWith("note") || type.startsWith("workflow") || type.startsWith("profile"),
    run: (conn, msg) => sendAll(conn, handleEditorMessage(conn.dataDir, msg as never)),
  },
  // The file explorer's semantic search.
  {
    owns: prefix("sem_"),
    run: async (conn, msg) => sendAll(conn, await handleSemanticMessage(conn.edge.semantic, record(msg))),
  },
  { owns: exact("hooks_get"), run: (conn) => pushHooks(conn) },
  { owns: exact("lists_get"), run: (conn) => sendLists(conn.edge, conn.send) },
  { owns: exact("interrupt"), run: (conn) => void conn.session.interrupt() },
  { owns: exact("ask_answer"), run: (conn, msg) => conn.prompter.settle(msg.text ?? "") },
  { owns: exact("line", "steer", "unqueue"), run: handleLineFamily },
];

/** Route one raw WebSocket message from the page. */
export function handleMessage(conn: ConnectionState, message: string | Buffer<ArrayBuffer> | null): void {
  let msg: WireMessage;
  try {
    msg = JSON.parse(String(message));
  } catch {
    return;
  }
  if (typeof msg?.type !== "string") return;
  const route = ROUTES.find((r) => r.owns(msg.type));
  if (!route) return;
  void Promise.resolve(route.run(conn, msg)).catch((error: unknown) => {
    console.error(`vise web: could not handle ${msg.type}:`, error);
  });
}
