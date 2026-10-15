/**
 * Minimal WebDriver BiDi client (the protocol Firefox speaks instead of CDP):
 * JSON-RPC over one WebSocket, with command ids correlated to replies and
 * events delivered by name. Unlike CDP there are no flat sessions; commands
 * name their tab (`context`) in their parameters.
 */

type Handler = (params: Record<string, unknown>) => void;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/** Events the backend listens to; subscribed once after `session.new`. */
const EVENTS = [
  "browsingContext.contextCreated",
  "browsingContext.contextDestroyed",
  "browsingContext.load",
  "browsingContext.userPromptOpened",
  "browsingContext.userPromptClosed",
];

export class BidiConnection {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly handlers = new Map<string, Set<Handler>>();

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => this.onMessage(String(event.data)));
    ws.addEventListener("close", () => this.failAll("connection closed"));
  }

  /** Open a connection to a BiDi WebSocket URL and start a session that leaves dialogs open. */
  static async connect(url: string): Promise<BidiConnection> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener("open", () => resolve(socket));
      socket.addEventListener("error", () => reject(new Error(`cannot connect to ${url}`)));
    });
    const bidi = new BidiConnection(ws);
    await bidi.send("session.new", {
      // Dialogs must stay open until the agent answers them.
      capabilities: { alwaysMatch: { unhandledPromptBehavior: "ignore" } },
    });
    await bidi.send("session.subscribe", { events: EVENTS });
    return bidi;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
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
      type?: string;
      id?: number;
      result?: unknown;
      message?: string;
      error?: string;
      method?: string;
      params?: Record<string, unknown>;
    };
    if (msg.id !== undefined) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if (msg.type === "error") {
        pending.reject(new Error(msg.message ?? msg.error ?? "BiDi error"));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }
    if (msg.method) {
      for (const handler of this.handlers.get(msg.method) ?? []) {
        handler(msg.params ?? {});
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
