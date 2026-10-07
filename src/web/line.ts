import type { Picture } from "../core/errors.ts";
import { formatCompactionFailure, formatError } from "../output/format.ts";
import type { LineResult, Session } from "../repl/session.ts";
import { loadSession } from "../sessions.ts";
import type { SessionLease } from "./leases.ts";
import { acceptPictures } from "./pictures.ts";

/** What a web connection's turns need to run: the session, how streaming is tracked, and a way to reply. */
type Send = (msg: Record<string, unknown>) => void;

export interface LineDisplay {
  reset(): void;
  readonly wasStreamed: boolean;
}

export interface LineConnection {
  session: Session;
  display: LineDisplay;
  send: Send;
  edge: { canSeeImages: () => Promise<boolean> };
  /** The folder's saved sessions and which of them this connection has open. */
  dataDir: string;
  lease: SessionLease;
  /** Lines run one after another: each waits for the previous turn. */
  chain: Promise<void>;
  /** Lines the user chose to hold back until the work in flight is done; they can still be removed. */
  held: HeldLine[];
  /** A line's turn is running now (steering applies only then). */
  running: boolean;
}

/** A line waiting its turn, shown in the page's queue. */
export interface HeldLine {
  qid: string;
  text: string;
}

/** Tell the page what is waiting. */
function publishQueue(conn: LineConnection): void {
  conn.send({
    type: "queue",
    items: conn.held.map(({ qid, text }) => ({ qid, text })),
  });
}

/** Drop held lines: one by id, or all of them. */
export function unqueue(conn: LineConnection, qid?: string): number {
  const before = conn.held.length;
  conn.held = qid === undefined ? [] : conn.held.filter((h) => h.qid !== qid);
  publishQueue(conn);
  return before - conn.held.length;
}

/** An error when `/resume <session>` names a session another connection has open; undefined otherwise. */
function openElsewhere(conn: LineConnection, line: string): string | undefined {
  const ref = /^\/resume\s+(\S+)/.exec(line.trim())?.[1];
  if (!ref) return undefined;
  const saved = loadSession(conn.dataDir, ref);
  return saved.ok && conn.lease.heldByOther(saved.value.id)
    ? `session '${saved.value.name}' is open in another tab; close that tab or resume another session`
    : undefined;
}

/**
 * Queue a line from the page behind the turn in flight. Pictures attached to
 * it are checked first (the page is not trusted), and refused when the active
 * model cannot see them.
 */
export function queueLine(
  conn: LineConnection,
  text: string,
  id: string | undefined,
  images: unknown,
  /** Set when the user chose to hold the line back; it then shows in the queue until it starts. */
  qid?: string,
): void {
  const reply = (error: string): void =>
    conn.send({
      type: "result",
      ok: false,
      error,
      ...(id === undefined ? {} : { id }),
    });
  let pictures: Picture[];
  try {
    pictures = acceptPictures(images);
  } catch (error) {
    reply(error instanceof Error ? error.message : String(error));
    return;
  }
  const held: HeldLine | undefined =
    qid === undefined ? undefined : { qid, text };
  if (held) {
    conn.held.push(held);
    publishQueue(conn);
  }
  conn.chain = conn.chain
    .then(async () => {
      if (held) {
        // Removed from the queue while it waited: it never runs.
        if (!conn.held.includes(held)) return;
        conn.held = conn.held.filter((h) => h !== held);
        publishQueue(conn);
      }
      if (pictures.length > 0 && !(await conn.edge.canSeeImages())) {
        reply("the active model cannot see images (switch with /model)");
        return;
      }
      const taken = openElsewhere(conn, text);
      if (taken) {
        reply(taken);
        return;
      }
      await runLine(conn, text, id, pictures, qid);
    })
    .catch((error: unknown) => reply(String(error)));
}

/**
 * Steer the turn in flight: the words reach the model before its next round
 * instead of waiting for the whole task. With no turn running (it just ended)
 * the words simply start one.
 */
export function steerLine(
  conn: LineConnection,
  text: string,
  images: unknown,
): void {
  if (!conn.running) {
    queueLine(conn, text, undefined, images);
    return;
  }
  let pictures: Picture[];
  try {
    pictures = acceptPictures(images);
  } catch (error) {
    conn.send({
      type: "notice",
      text: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  void (async () => {
    if (pictures.length > 0 && !(await conn.edge.canSeeImages())) {
      conn.send({
        type: "notice",
        text: "the active model cannot see images (switch with /model)",
      });
      return;
    }
    // The turn may have ended while the pictures were checked.
    if (conn.running) {
      conn.session.notices.steer({
        role: "user",
        content: text,
        typed: true,
        ...(pictures.length > 0 ? { images: pictures } : {}),
      });
    }
    else queueLine(conn, text, undefined, images);
  })();
}

/** One line's turn, then any steering the model never got to read as turns of their own. */
async function runLine(
  conn: LineConnection,
  text: string,
  id: string | undefined,
  pictures: Picture[],
  qid: string | undefined,
): Promise<void> {
  const { session, display, send } = conn;
  conn.running = true;
  try {
    send({ type: "line_started", text, ...(qid === undefined ? {} : { qid }) });
    await handleLine(session, display, send, text, id, pictures);
    // Steering the model never read runs as turns of its own. The empty check
    // and `running = false` happen with no await between them, so a steer
    // either lands in this loop or sees `running` false and starts a turn.
    for (let left = session.notices.takeSteers(); left.length > 0; ) {
      for (const steer of left) {
        send({ type: "line_started", text: steer.content });
        await handleLine(session, display, send, steer.content, undefined, steer.images);
      }
      left = session.notices.takeSteers();
    }
  } finally {
    conn.running = false;
    // Whatever session the conversation now writes to is this connection's to keep.
    conn.lease.follow(session.getSessionId());
  }
}

async function handleLine(
  session: Session,
  display: LineDisplay,
  send: Send,
  line: string,
  id?: string,
  images: Picture[] = [],
): Promise<void> {
  display.reset();
  const result: LineResult = await session.handleLine(line, images);
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
