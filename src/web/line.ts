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
): void {
  const { send, session, display } = conn;
  const reply = (error: string): void =>
    send({
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
  conn.chain = conn.chain
    .then(async () => {
      if (pictures.length > 0 && !(await conn.edge.canSeeImages())) {
        reply("the active model cannot see images (switch with /model)");
        return;
      }
      const taken = openElsewhere(conn, text);
      if (taken) {
        reply(taken);
        return;
      }
      await handleLine(session, display, send, text, id, pictures);
      // Whatever session the conversation now writes to is this connection's to keep.
      conn.lease.follow(session.getSessionId());
    })
    .catch((error: unknown) => reply(String(error)));
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
