import type { ServerMessage } from "./server-message.ts";

/** What one progress report looks like on the bar. */
export interface ProgressView {
  done: boolean;
  /** Percent of the prompt served from the cache. */
  cachedPct: number;
  /** Percent computed so far, after the cached part. */
  computedPct: number;
  /** Percent of the whole prompt read so far. */
  valueNow: number;
  text: string;
}

/** Turn a report into what is drawn; undefined when it carries no prompt size. */
export function describeProgress(
  message: Pick<ServerMessage, "total" | "cache" | "processed" | "time_ms">,
): ProgressView | undefined {
  const total = message.total ?? 0;
  if (total <= 0) return undefined;
  const processed = Math.min(Math.max(message.processed ?? 0, 0), total);
  const cache = Math.min(Math.max(message.cache ?? 0, 0), processed);
  const pct = (n: number): number => (n / total) * 100;
  const done = processed >= total;
  const fromCache = cache > 0 ? ` · ${cache} cached` : "";
  return {
    done,
    cachedPct: pct(cache),
    computedPct: pct(processed - cache),
    valueNow: Math.round(pct(processed)),
    text: done
      ? `prompt ${total} tokens${fromCache} · ${((message.time_ms ?? 0) / 1000).toFixed(1)} s`
      : `prompt ${processed}/${total}${fromCache}`,
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
  cached: HTMLElement;
  label: HTMLElement;
  request: number | undefined;
}

/**
 * Shows llama.cpp's prompt processing in the chat log, as the terminal does:
 * one line per request that fills a bar while the prompt is read, with the part
 * served from the cache in a muted shade, and ends as a summary once done.
 * The silent wait before the first token is otherwise a blank screen.
 */
export function createPromptProgress(
  addLine: (cls: string, text: string) => HTMLElement,
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
    const cached = document.createElement("span");
    cached.className = "progress-cached";
    const fill = document.createElement("span");
    fill.className = "progress-fill";
    bar.append(cached, fill);
    const label = document.createElement("span");
    label.className = "progress-label";
    line.append(bar, label);
    return { line, bar, fill, cached, label, request };
  }

  return {
    handle(message) {
      const view = describeProgress(message);
      if (!view) return;
      const shown = open && { request: open.request, attached: open.line.isConnected };
      if (!open || startsNewBar(shown, message.request)) open = start(message.request);
      // Segments left to right: served from the cache, computed so far, still to do.
      open.cached.style.width = `${view.cachedPct}%`;
      open.fill.style.left = `${view.cachedPct}%`;
      open.fill.style.width = `${view.computedPct}%`;
      open.bar.setAttribute("aria-valuenow", String(view.valueNow));
      open.label.textContent = view.text;
      if (view.done) {
        open.line.classList.add("done");
        open = null;
      }
    },
  };
}
