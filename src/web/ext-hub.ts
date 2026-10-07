import type { ExtensionLink } from "../browser/extension.ts";

/**
 * The server's end of the Firefox extension's WebSocket (`/ext`). The
 * extension connects once and stays connected; the hub turns the sessions'
 * browser calls into request/response messages for it. Wire protocol (JSON):
 *   server → extension: { id, op, params }
 *   extension → server: { id, ok:true, result } | { id, ok:false, error }
 *                       { event:"tabs" }     the tabs Vise may use changed
 * There is one extension at a time: a newer connection replaces the old one.
 */

/** The slice of a WebSocket the hub uses. */
export interface ExtensionSocket {
  send(data: string): void;
  close(): void;
}

const CALL_TIMEOUT_MS = 30_000;

export const NOT_CONNECTED =
  "the Vise Firefox extension is not connected: load it in Firefox and open its sidebar (about:debugging, Load Temporary Add-on)";

/** Browsers must be the extension itself; a web page cannot forge a `moz-extension://` Origin. */
export function isExtensionOrigin(origin: string | null): boolean {
  return origin !== null && origin.startsWith("moz-extension://");
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ExtensionHub implements ExtensionLink {
  private socket: ExtensionSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<() => void>();

  get connected(): boolean {
    return this.socket !== null;
  }

  /** The extension connected; any earlier connection is dropped. */
  attach(socket: ExtensionSocket): void {
    const old = this.socket;
    this.socket = socket;
    if (old && old !== socket) {
      this.failAll("the extension reconnected");
      old.close();
    }
    this.notify();
  }

  /** The extension's socket closed. */
  detach(socket: ExtensionSocket): void {
    if (this.socket !== socket) return;
    this.socket = null;
    this.failAll("the extension disconnected");
    this.notify();
  }

  call(op: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const socket = this.socket;
    if (!socket) return Promise.reject(new Error(NOT_CONNECTED));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the extension did not answer '${op}' in time`));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, op, params }));
    });
  }

  onEvent(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** A message from the extension (a reply to a call, or an event). */
  handleMessage(raw: string): void {
    let msg: {
      id?: number;
      ok?: boolean;
      result?: unknown;
      error?: string;
      event?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.event === "tabs") {
      this.notify();
      return;
    }
    const pending =
      typeof msg.id === "number" ? this.pending.get(msg.id) : undefined;
    if (!pending || msg.id === undefined) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.ok) pending.resolve(msg.result);
    else
      pending.reject(new Error(msg.error ?? "the extension reported an error"));
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  private failAll(reason: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
  }
}
