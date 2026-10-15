/**
 * Holds a WebSocket's messages until its connection exists. A page's session
 * can only be built once its folder's MCP servers are up (the tool list is
 * fixed for the conversation), so the connection opens a little after the
 * socket does; messages sent meanwhile are kept in order and handled first.
 * A socket that closes (or fails to start) in the meantime is abandoned, so
 * whatever `start` acquired for it is given back exactly once.
 */
export interface GateHandlers<W, C, M> {
  /** Acquire what the connection needs and say when it is ready; may throw. */
  start(ws: W): Promise<unknown>;
  /** Build the connection once ready. */
  open(ws: W): C;
  handle(conn: C, message: M): void;
  /** An open connection closed. */
  teardown(conn: C): void;
  /** The socket closed or failed before its connection opened. */
  abandon(ws: W): void;
  /** The connection could not be set up. */
  fail(ws: W, error: unknown): void;
}

export interface Gate<W, M> {
  open(ws: W): void;
  message(ws: W, message: M): void;
  close(ws: W): void;
}

export function createGate<W, C, M>(h: GateHandlers<W, C, M>): Gate<W, M> {
  const waiting = new Map<W, M[]>();
  const open = new Map<W, C>();

  const settle = (ws: W): void => {
    const held = waiting.get(ws);
    if (!held) return; // closed while waiting; `close` already abandoned it
    waiting.delete(ws);
    try {
      const conn = h.open(ws);
      open.set(ws, conn);
      for (const message of held) h.handle(conn, message);
    } catch (err) {
      h.abandon(ws);
      h.fail(ws, err);
    }
  };

  return {
    open(ws) {
      let ready: Promise<unknown>;
      try {
        ready = h.start(ws);
      } catch (err) {
        h.fail(ws, err);
        return;
      }
      waiting.set(ws, []);
      ready.then(
        () => settle(ws),
        (err: unknown) => {
          if (!waiting.delete(ws)) return;
          h.abandon(ws);
          h.fail(ws, err);
        },
      );
    },
    message(ws, message) {
      const held = waiting.get(ws);
      if (held) held.push(message);
      else {
        const conn = open.get(ws);
        if (conn) h.handle(conn, message);
      }
    },
    close(ws) {
      if (waiting.delete(ws)) {
        h.abandon(ws);
        return;
      }
      const conn = open.get(ws);
      open.delete(ws);
      if (conn) h.teardown(conn);
    },
  };
}
