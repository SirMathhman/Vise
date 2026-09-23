// The web implementation of the swappable Transport seam (src/transport.ts).
// It owns a WebSocket connection plus an input line queue that mirrors
// src/repl/input.ts semantics (buffer lines, nextLine drains, nextFreshLine
// clears-and-waits, close sets a closed flag and resolves pending waiters
// with ""). Each render method sends the corresponding ServerMessage frame
// over the socket; the replyStream/thinkingIndicator/prefillIndicator
// factory methods return handles that emit reply_delta / status frames.
// handleMessage is called by server.ts on every WS message. The transport
// outlives any one socket: server.ts attaches a socket on connect and
// detaches it on disconnect (frames sent while detached are dropped), so a
// browser reload resumes the same session. Only an explicit client `close`
// frame ends input.
import type {
  CommandRender,
  PrefillIndicator,
  ReplyStream,
  ThinkingIndicator,
  Transport,
} from "../transport.ts";
import type { ClientMessage, ServerMessage } from "./protocol.ts";

// Minimal structural view of the WebSocket socket. Decoupled from Bun's
// exact server-websocket type so this module stays importable and testable
// without pulling in the full Bun.serve surface.
export type WebSocketConnection = {
  send: (data: string) => void;
};

export class WebTransport implements Transport {
  private socket: WebSocketConnection | null;
  // The unanswered ask_user question, re-sent on reattach so a reload
  // during a question leaves it answerable.
  private pendingQuestion: ServerMessage | null = null;
  private readonly lines: string[] = [];
  private closed = false;
  private waitingForFreshLine = false;
  private nextLineResolvers: Array<(value: string) => void> = [];
  private freshLineResolvers: Array<(value: string) => void> = [];

  constructor(socket: WebSocketConnection) {
    this.socket = socket;
  }

  attach(socket: WebSocketConnection): void {
    this.socket = socket;
    if (this.pendingQuestion) this.send(this.pendingQuestion);
    this.send({ type: "prompt" });
  }

  detach(): void {
    this.socket = null;
  }

  isAttached(): boolean {
    return this.socket !== null;
  }

  isAttachedTo(socket: WebSocketConnection): boolean {
    return this.socket === socket;
  }

  // Called by server.ts when a WS message arrives. Parses the ClientMessage
  // and feeds the line queue (input) or tears the transport down (close).
  handleMessage(data: string): void {
    let message: ClientMessage;
    try {
      message = JSON.parse(data) as ClientMessage;
    } catch {
      return; // Ignore malformed frames; the session continues.
    }
    if (message.type === "input") {
      this.pushLine(message.text);
    } else if (message.type === "close") {
      this.close();
    }
  }

  // A line of input has arrived. If a nextFreshLine wait is pending (the
  // user is answering an ask_user question), resolve it directly; otherwise
  // hand it to a pending nextLine waiter, or buffer it for the next drain.
  // Mirrors src/repl/input.ts.
  private pushLine(line: string): void {
    if (this.waitingForFreshLine) {
      this.waitingForFreshLine = false;
      this.pendingQuestion = null;
      this.freshLineResolvers.shift()?.(line);
      return;
    }
    const waiter = this.nextLineResolvers.shift();
    if (waiter) waiter(line);
    else this.lines.push(line);
  }

  // Teardown: mark closed and resolve any pending waiters with "" (EOF),
  // mirroring src/repl/input.ts close semantics so run() breaks cleanly.
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.waitingForFreshLine = false;
    for (const resolve of this.nextLineResolvers) resolve("");
    this.nextLineResolvers = [];
    for (const resolve of this.freshLineResolvers) resolve("");
    this.freshLineResolvers = [];
  }

  private send(message: ServerMessage): void {
    if (this.closed || !this.socket) return;
    this.socket.send(JSON.stringify(message));
  }

  // --- Input (WebSocket). Mirrors src/repl/input.ts. ---
  nextLine(): Promise<string> {
    if (this.lines.length > 0) {
      return Promise.resolve(this.lines.shift() ?? "");
    }
    if (this.closed) return Promise.resolve("");
    return new Promise((resolve) => {
      this.nextLineResolvers.push(resolve);
    });
  }

  nextFreshLine(): Promise<string> {
    this.lines.length = 0;
    if (this.closed) return Promise.resolve("");
    this.waitingForFreshLine = true;
    return new Promise((resolve) => {
      this.freshLineResolvers.push(resolve);
    });
  }

  // --- One-shot renders. Each sends the matching ServerMessage frame. ---
  prompt(): void {
    this.send({ type: "prompt" });
  }

  question(
    question: string,
    type: "freeform" | "multiple_choice" | "multiple_select",
    options?: string[],
  ): void {
    this.pendingQuestion = { type: "question", question, kind: type, options };
    this.send(this.pendingQuestion);
  }

  toolCallStart(
    name: string,
    args: Record<string, unknown>,
    depth: number,
  ): void {
    this.send({ type: "tool_call_start", name, args, depth });
  }

  toolCallEnd(
    name: string,
    durationMs: number,
    status: "done" | "failed" | "disabled" | "unknown",
    depth: number,
  ): void {
    this.send({ type: "tool_call_end", name, durationMs, status, depth });
  }

  command(result: CommandRender): void {
    this.send({
      type: "command",
      lines: result.lines,
      isError: result.isError,
      sessionNames: result.sessionNames,
    });
  }

  error(message: string): void {
    this.send({ type: "error", message });
  }

  hook(label: string, output: string, exitCode: number): void {
    this.send({ type: "hook", label, output, exitCode });
  }

  compactNotice(): void {
    this.send({ type: "compact_notice" });
  }

  // --- Diagnostics. ---
  log(message: string): void {
    this.send({ type: "log", message });
  }

  // --- Stateful handles (one per model completion). ---
  replyStream(): ReplyStream {
    let ended = false;
    let cancelled = false;
    return {
      write: (delta: string) => {
        if (ended || cancelled) return;
        this.send({ type: "reply_delta", text: delta });
      },
      end: () => {
        if (ended || cancelled) return;
        ended = true;
        this.send({ type: "reply_end" });
      },
      cancel: () => {
        if (ended || cancelled) return;
        cancelled = true;
        this.send({ type: "reply_cancel" });
      },
    };
  }

  thinkingIndicator(): ThinkingIndicator {
    let started = false;
    let finished = false;
    return {
      start: () => {
        if (started || finished) return;
        started = true;
        this.send({ type: "status", phase: "thinking", elapsedMs: 0 });
      },
      report: (tokens: number) => {
        if (!started || finished) return;
        this.send({
          type: "status",
          phase: "thinking",
          elapsedMs: 0,
          tokens,
        });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (started) this.send({ type: "status", phase: "done", elapsedMs: 0 });
      },
    };
  }

  prefillIndicator(): PrefillIndicator {
    let started = false;
    let finished = false;
    return {
      start: () => {
        if (started || finished) return;
        started = true;
        this.send({
          type: "status",
          phase: "prefill",
          elapsedMs: 0,
          processed: 0,
          total: 0,
          cache: 0,
        });
      },
      report: (
        processed: number,
        total: number,
        cache: number,
        timeMs: number,
      ) => {
        if (!started || finished) return;
        this.send({
          type: "status",
          phase: "prefill",
          elapsedMs: timeMs,
          processed,
          total,
          cache,
        });
      },
      finish: () => {
        if (finished) return;
        finished = true;
        if (started) this.send({ type: "status", phase: "done", elapsedMs: 0 });
      },
    };
  }
}
