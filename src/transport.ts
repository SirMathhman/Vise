// The swappable transport seam between the core turn loop and a concrete
// frontend (terminal today; a web UI or TUI later). The core (loop.ts) talks
// only to this interface; a concrete implementation owns how input is read
// (stdin) and how output is rendered (stdout), plus a diagnostic channel for
// housekeeping messages that are not part of the conversation.
//
// This is the "Transport" the architecture names: "how stdin is read and how
// output is rendered (prompts, assistant replies, errors). Swappable, and the
// only module allowed to touch process.stdin/process.stdout."
//
// The terminal implementation (src/repl/terminalTransport.ts) delegates to
// src/repl/input.ts and src/repl/render.ts. A future web UI or TUI provides
// its own implementation of this same interface and is handed in from the
// entry point, so the same core can drive a terminal, a web UI, or a TUI.
//
// Pure types; no I/O. No import of any handler module.

// A streaming reply handle owned by the transport. The loop forwards content
// deltas to write() as they arrive; end() terminates the reply and is
// idempotent (a second end() or a write() after end() is a no-op); cancel()
// closes a partial reply without the terminator.
export type ReplyStream = {
  write: (delta: string) => void;
  end: () => void;
  cancel: () => void;
};

// A bounded one-line "thinking" indicator for one model completion. The
// model's reasoning can be arbitrarily long, so the indicator never shows the
// reasoning text itself — it repaints a single line with an elapsed time and
// a running token estimate, then settles into a one-line "thought" marker
// when the answer (or a tool call) begins.
export type ThinkingIndicator = {
  start: () => void;
  report: (tokens: number) => void;
  finish: () => void;
};

// A bounded one-line "prefilling" indicator for one model completion, shown
// while the server reports prefill (prompt-processing) progress before any
// token is generated. Inert when the server doesn't report progress (older
// builds), in which case start is never called.
export type PrefillIndicator = {
  start: () => void;
  report: (
    processed: number,
    total: number,
    cache: number,
    timeMs: number,
  ) => void;
  finish: () => void;
};

// The rendered payload for a built-in command's output. The core's command
// registry returns this; the transport renders it (and nothing else).
export type CommandRender = {
  lines: string[];
  isError?: boolean;
};

// The swappable transport seam. The core turn loop (loop.ts) depends only on
// this interface; it never imports the concrete terminal rendering or stdin
// reader directly. A frontend implements this and is handed in from the
// entry point (alongside Config), so the same core can drive a terminal, a
// web UI, or a TUI.
export type Transport = {
  // --- Input (stdin). nextLine resolves the next buffered line (or "" once
  // input has closed and no lines remain). nextFreshLine discards buffered
  // input and waits for a newly entered line (used to answer an ask_user
  // question without consuming a piped line). close tears the input down.
  nextLine: () => Promise<string>;
  nextFreshLine: () => Promise<string>;
  close: () => void;

  // --- One-shot renders ---
  prompt: () => void;
  question: (
    question: string,
    type: "freeform" | "multiple_choice" | "multiple_select",
    options?: string[],
  ) => void;
  toolCallStart: (
    name: string,
    args: Record<string, unknown>,
    depth: number,
  ) => void;
  toolCallEnd: (
    name: string,
    durationMs: number,
    status: "done" | "failed" | "disabled" | "unknown",
    depth: number,
  ) => void;
  command: (result: CommandRender) => void;
  error: (message: string) => void;
  hook: (label: string, output: string, exitCode: number) => void;
  compactNotice: () => void;

  // --- Stateful handles (one per model completion) ---
  replyStream: () => ReplyStream;
  thinkingIndicator: () => ThinkingIndicator;
  prefillIndicator: () => PrefillIndicator;

  // --- Diagnostics (logging channel, distinct from user-facing output).
  // Carries housekeeping messages ([compact] ..., [index] ...) that are not
  // part of the conversation and are not rendered by the reply stream.
  log: (message: string) => void;
};
