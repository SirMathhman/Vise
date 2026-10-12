import type { TerminalAttachment } from "./terminal-registry.ts";

/** A terminal message from the page (`term_*`). */
export interface TerminalMessage {
  type: string;
  data?: unknown;
  cols?: unknown;
  rows?: unknown;
}

const MAX_SIZE = 500;

/** A terminal dimension from the page: an integer from 1 to 500, else `fallback`. */
export function terminalSize(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_SIZE, Math.max(1, Math.round(value)));
}

/**
 * Handle one `term_*` message. `terminal` is null for a session that has no
 * terminal (no folder, or the extension's sidebar). Never queued behind a turn.
 */
export function handleTerminalMessage(
  terminal: TerminalAttachment | null,
  msg: TerminalMessage,
  send: (msg: Record<string, unknown>) => void,
): void {
  if (!terminal) {
    if (msg.type === "term_open")
      send({ type: "term_error", message: "no terminal: this session has no folder" });
    return;
  }
  const cols = terminalSize(msg.cols, 80);
  const rows = terminalSize(msg.rows, 24);
  switch (msg.type) {
    case "term_open":
      terminal.open(cols, rows);
      return;
    case "term_input":
      if (typeof msg.data === "string") terminal.input(msg.data);
      return;
    case "term_resize":
      terminal.resize(cols, rows);
      return;
    case "term_restart":
      terminal.restart();
      return;
    case "term_close":
      terminal.close();
      return;
  }
}
