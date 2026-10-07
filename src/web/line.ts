import type { Picture } from "../core/errors.ts";
import { formatCompactionFailure, formatError } from "../output/format.ts";
import type { LineResult, Session } from "../repl/session.ts";
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
  /** Lines run one after another: each waits for the previous turn. */
  chain: Promise<void>;
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
      await handleLine(session, display, send, text, id, pictures);
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
