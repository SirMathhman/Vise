/** What the page does as the connection comes and goes. */
export interface ConnectionHandlers {
  onOpen(): void;
  /** The connection dropped; `retryInMs` is when the next attempt is made. */
  onClose(retryInMs: number): void;
  onMessage(data: string): void;
}

/** Waits between attempts to reconnect: quick at first, then every 15 s. */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];

/** Where the page's WebSocket goes: the same host, with the page's query (its folder, sidebar mode). */
function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws${location.search}`;
}

/**
 * The page's WebSocket to the server, reconnected when it drops (the server
 * restarted, the laptop slept): each new connection restores the folder's
 * session, so the conversation comes back by itself. `send` drops messages
 * while there is no connection, as the page did before.
 */
export function createConnection(handlers: ConnectionHandlers): {
  send(msg: Record<string, unknown>): void;
  isOpen(): boolean;
} {
  let socket: WebSocket;
  let attempt = 0;
  const connect = (): void => {
    socket = new WebSocket(socketUrl());
    socket.addEventListener("open", () => {
      attempt = 0;
      handlers.onOpen();
    });
    socket.addEventListener("close", () => {
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 15000;
      attempt += 1;
      handlers.onClose(wait);
      setTimeout(connect, wait);
    });
    socket.addEventListener("message", (event: MessageEvent<string>) =>
      handlers.onMessage(event.data),
    );
  };
  connect();
  return {
    send(msg) {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
    },
    isOpen: () => socket.readyState === WebSocket.OPEN,
  };
}
