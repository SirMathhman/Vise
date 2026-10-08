import type { ServerMessage } from "./server-message.ts";

/** How long nothing visible may happen during a model call before the page says it is still writing. */
export const QUIET_MS = 1500;

/** Whether the "still writing" line should show: the call has not ended and nothing visible has happened for a while. */
export function shouldShowWriting(done: boolean, quietForMs: number): boolean {
  return !done && quietForMs >= QUIET_MS;
}

/** The line's text: what is being written and how much so far. */
export function describeWriting(tokens: number, tool: string | undefined): string {
  const what = tool ? `Writing ${tool}` : "Writing";
  return `${what} · ${tokens.toLocaleString("en-US")} tokens`;
}

/** The messages that put something on the page (or end the work), so the model is visibly not idle. */
const VISIBLE = new Set([
  "token",
  "thinking",
  "subagent_token",
  "tool",
  "tool_result",
  "image",
  "ask",
  "result",
  "exit",
]);

/**
 * A model call that writes a long tool call (500 lines of a file, say) streams
 * nothing the page can show, so it looks idle. This keeps one pulsing line at
 * the end of the log while the server reports tokens but nothing else has
 * appeared; any visible activity, the end of the call or of the turn removes it.
 */
export function createGenerating(
  addLine: (cls: string, text: string) => HTMLElement,
  removeLine: (element: HTMLElement) => void,
  now: () => number = Date.now,
): { observe(message: ServerMessage): void } {
  let line: HTMLElement | null = null;
  let lastActivity = now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (line) removeLine(line);
    line = null;
  };
  /** The call has gone quiet: show the line at the bottom of the log, or move it there. */
  const show = (text: string): void => {
    if (line && !line.isConnected) line = null;
    if (line?.nextElementSibling) {
      removeLine(line);
      line = null;
    }
    if (!line) line = addLine("generating", text);
    else line.textContent = text;
  };

  return {
    observe(message) {
      if (message.type !== "generating") {
        // Anything the user can see happening, or the turn ending, means it is not idle.
        if (VISIBLE.has(message.type)) {
          lastActivity = now();
          clear();
        }
        return;
      }
      const quiet = now() - lastActivity;
      if (message.done === true) return clear();
      const text = describeWriting(message.tokens ?? 0, message.text);
      if (shouldShowWriting(false, quiet)) return show(text);
      // Not quiet long enough yet: look again when it will have been.
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (shouldShowWriting(false, now() - lastActivity)) show(text);
      }, QUIET_MS - quiet);
    },
  };
}
