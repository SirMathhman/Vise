/**
 * Minimal Chrome DevTools Protocol client: JSON-RPC over one WebSocket, with
 * flat-session routing (`sessionId`) so a single connection drives many tabs.
 */

type Handler = (params: Record<string, unknown>, sessionId?: string) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<Handler>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.failAll("connection closed"));
  }

  /** Open a connection to a DevTools WebSocket URL. */
  static connect(url: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new CdpConnection(ws)));
      ws.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    });
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Subscribe to a protocol event; returns an unsubscribe function. */
  on(method: string, handler: Handler): () => void {
    const set = this.handlers.get(method) ?? new Set<Handler>();
    set.add(handler);
    this.handlers.set(method, set);
    return () => set.delete(handler);
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    const msg = JSON.parse(raw) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message));
      else pending.resolve(msg.result);
      return;
    }
    if (msg.method) {
      for (const handler of this.handlers.get(msg.method) ?? []) {
        handler(msg.params ?? {}, msg.sessionId);
      }
    }
  }

  private failAll(reason: string): void {
    for (const pending of this.pending.values()) {
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
