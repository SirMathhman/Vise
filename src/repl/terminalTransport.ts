// The terminal implementation of the swappable Transport seam
// (src/transport.ts). It owns the concrete stdin/stdout surface: it delegates
// to src/repl/input.ts for stdin and src/repl/render.ts for rendering, so the
// terminal behavior is unchanged from before the seam was introduced. A future
// web UI or TUI would provide a different implementation of the same
// Transport interface and be handed in from the entry point.
import type {
  CommandRender,
  PrefillIndicator,
  ReplyStream,
  ThinkingIndicator,
  Transport,
} from "../transport.ts";
import { createInput } from "./input.ts";
import {
  createPrefillIndicator,
  createReplyStream,
  createThinkingIndicator,
  renderCommand,
  renderCompactNotice,
  renderError,
  renderHook,
  renderPrompt,
  renderQuestion,
  renderToolCallEnd,
  renderToolCallStart,
} from "./render.ts";

export function createTerminalTransport(): Transport {
  const input = createInput();
  return {
    // Input (stdin).
    nextLine: input.nextLine,
    nextFreshLine: input.nextFreshLine,
    close: input.close,

    // One-shot renders.
    prompt: renderPrompt,
    question: (q, type, options) => renderQuestion(q, type, options),
    toolCallStart: (name, args, depth) =>
      renderToolCallStart(name, args, depth),
    toolCallEnd: (name, durationMs, status, depth) =>
      renderToolCallEnd(name, durationMs, status, depth),
    command: (result: CommandRender) => renderCommand(result),
    error: (message: string) => renderError(message),
    hook: (label, output, exitCode) => renderHook(label, output, exitCode),
    compactNotice: renderCompactNotice,

    // Stateful handles, one per model completion.
    replyStream: (): ReplyStream => createReplyStream(),
    thinkingIndicator: (): ThinkingIndicator => createThinkingIndicator(),
    prefillIndicator: (): PrefillIndicator => createPrefillIndicator(),

    // Diagnostics.
    log: (message: string) => {
      process.stderr.write(`${message}\n`);
    },
  };
}
