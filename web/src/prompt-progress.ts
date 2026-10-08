import type { PromptProgress } from "../../src/core/errors.ts";
import { describeCall, readCall } from "../../src/core/progress.ts";
import type { ServerMessage } from "./server-message.ts";

/** What one progress report looks like on the bar. */
export interface ProgressView {
  done: boolean;
  /** Percent of the tokens this call has to read that it has read. */
  pct: number;
  text: string;
}

/**
 * Turn a report into what is drawn; undefined when it carries no prompt size.
 * The bar counts only the tokens this call actually reads (the new part of the
 * prompt), not the whole conversation the server already holds.
 */
export function describeProgress(
  message: Pick<ServerMessage, "total" | "cache" | "processed" | "time_ms" | "purpose">,
): ProgressView | undefined {
  const report: PromptProgress = {
    total: message.total ?? 0,
    cache: message.cache ?? 0,
    processed: message.processed ?? 0,
    time_ms: message.time_ms ?? 0,
    ...(message.purpose ? { purpose: message.purpose } : {}),
  };
  const reading = readCall(report);
  const text = describeCall(report);
  if (!reading || text === undefined) return undefined;
  return {
    done: reading.finished,
    pct: reading.total > 0 ? (reading.done / reading.total) * 100 : 100,
    text,
  };
}

/**
 * Whether a report starts a new bar: there is none open, or it is another
 * request (the client numbers them), or the old bar was removed from the page
 * (the log was cleared by /new or a resume).
 */
export function startsNewBar(
  open: { request: number | undefined; attached: boolean } | null,
  request: number | undefined,
): boolean {
  return !open || !open.attached || open.request !== request;
}

interface Bar {
  line: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  label: HTMLElement;
  request: number | undefined;
}

/**
 * Shows llama.cpp's prompt processing in the chat log, as the terminal does:
 * one line per model call that fills a bar while the call reads its new tokens
 * (labelled by what the call is for), and goes away when the call is done.
 * The silent wait before the first token is otherwise a blank screen.
 */
export function createPromptProgress(
  addLine: (cls: string, text: string) => HTMLElement,
  removeLine: (element: HTMLElement) => void,
): { handle(message: ServerMessage): void } {
  let open: Bar | null = null;

  function start(request: number | undefined): Bar {
    const line = addLine("progress", "");
    const bar = document.createElement("span");
    bar.className = "progress-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", "Prompt processing");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    const fill = document.createElement("span");
    fill.className = "progress-fill";
    bar.append(fill);
    const label = document.createElement("span");
    label.className = "progress-label";
    line.append(bar, label);
    return { line, bar, fill, label, request };
  }

  return {
    handle(message) {
      const view = describeProgress(message);
      if (!view) return;
      const shown = open && { request: open.request, attached: open.line.isConnected };
      if (!open || startsNewBar(shown, message.request)) open = start(message.request);
      open.fill.style.width = `${view.pct}%`;
      open.bar.setAttribute("aria-valuenow", String(Math.round(view.pct)));
      open.label.textContent = view.text;
      // A finished call has nothing left to show: the bar goes away (and is no part of the conversation's record).
      if (view.done) {
        removeLine(open.line);
        open = null;
      }
    },
  };
}
