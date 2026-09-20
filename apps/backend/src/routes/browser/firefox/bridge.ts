import { badRequest } from "../../../errors.js";
import type { LlmToolResult } from "../../llmToolTypes.js";

/**
 * The link to the Vise Firefox extension, which lets the model drive the
 * user's own Firefox instead of the headless Chrome page (see the extension in
 * apps/firefox-extension). The backend can't push to an extension, and Node has
 * no built-in WebSocket server, so the extension long-polls: it holds a
 * `poll()` request open, gets one command per response, runs it in the browser,
 * and posts the result back with `deliver()`. That needs only plain HTTP, keeps
 * the backend dependency-free, and makes the extension the one that reaches out.
 */

/** How long a poll waits for a command before returning empty (the extension re-polls). */
const POLL_HOLD_MS = 25_000;
/**
 * How long a gap between polls the extension is allowed before it counts as
 * gone. It re-polls immediately after each answer, so a longer gap means Firefox
 * was closed without detaching, and the tools should fall back to Chrome.
 */
const ALIVE_MS = 10_000;
/** How long a command may wait for the extension's answer (a page load can take a while). */
const CALL_TIMEOUT_MS = 60_000;

/** One browser tool call, sent to the extension. */
export interface BridgeCommand {
  id: string;
  tool: string;
  args: Record<string, unknown>;
}

/** The extension's answer to a command. */
export interface BridgeResult {
  id: string;
  ok: boolean;
  /** The tool's model-readable text (when ok). */
  result?: string;
  /** Images (data URLs) the tool returned, e.g. a screenshot (when ok). */
  images?: string[];
  /** What went wrong (when not ok). */
  error?: string;
}

export interface FirefoxBridge {
  /** Whether the extension is attached and polling. */
  connected(): boolean;
  /** Send a browser tool call to the extension and wait for its result. */
  call(
    tool: string,
    args: Record<string, unknown>
  ): Promise<string | LlmToolResult>;
  /** The extension's long poll: the next command, or null after a quiet interval. */
  poll(): Promise<BridgeCommand | null>;
  /** Put a command back at the front of the queue (its poll connection died before delivery). */
  requeue(cmd: BridgeCommand): void;
  /** The extension's answer to a command. */
  deliver(result: BridgeResult): void;
  /** The extension is detaching (the user turned it off). */
  goodbye(): void;
  /** Drop everything; called when the app closes. */
  close(): void;
}

interface Pending {
  resolve: (r: string | LlmToolResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export function createFirefoxBridge(): FirefoxBridge {
  const queue: BridgeCommand[] = [];
  // At most one extension polls; a newer poll supersedes an older waiting one.
  let waiter:
    | { resolve: (c: BridgeCommand | null) => void; timer: NodeJS.Timeout }
    | undefined;
  const pending = new Map<string, Pending>();
  let attached = false;
  let lastSeen = 0;
  let nextId = 1;

  function releaseWaiter(cmd: BridgeCommand | null): void {
    if (!waiter) return;
    clearTimeout(waiter.timer);
    const w = waiter;
    waiter = undefined;
    w.resolve(cmd);
  }

  function failAll(message: string): void {
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(badRequest(message));
      pending.delete(id);
    }
    queue.length = 0;
  }

  const connected = (): boolean =>
    attached && (waiter !== undefined || Date.now() - lastSeen < ALIVE_MS);

  return {
    connected,

    call(tool, args) {
      if (!connected()) {
        return Promise.reject(
          badRequest("the Firefox extension is not attached")
        );
      }
      const id = String(nextId++);
      const cmd: BridgeCommand = { id, tool, args };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            badRequest(
              `Firefox did not answer within ${CALL_TIMEOUT_MS / 1000}s`
            )
          );
        }, CALL_TIMEOUT_MS);
        pending.set(id, { resolve, reject, timer });
        if (waiter) releaseWaiter(cmd);
        else queue.push(cmd);
      });
    },

    poll() {
      attached = true;
      lastSeen = Date.now();
      releaseWaiter(null); // a newer poll supersedes an older one
      const next = queue.shift();
      if (next) return Promise.resolve(next);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiter = undefined;
          lastSeen = Date.now();
          resolve(null);
        }, POLL_HOLD_MS);
        waiter = { resolve, timer };
      });
    },

    requeue(cmd) {
      if (pending.has(cmd.id)) queue.unshift(cmd);
    },

    deliver(result) {
      const p = pending.get(result.id);
      if (!p) return; // it already timed out
      pending.delete(result.id);
      clearTimeout(p.timer);
      if (!result.ok) {
        p.reject(badRequest(result.error || "Firefox reported an error"));
      } else if (result.images && result.images.length > 0) {
        p.resolve({ text: result.result ?? "", images: result.images });
      } else {
        p.resolve(result.result ?? "");
      }
    },

    goodbye() {
      attached = false;
      releaseWaiter(null);
      failAll("the Firefox extension detached");
    },

    close() {
      attached = false;
      releaseWaiter(null);
      failAll("the app is closing");
    },
  };
}
