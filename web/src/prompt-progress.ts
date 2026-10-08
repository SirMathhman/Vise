import type { ServerMessage } from "./server-message.ts";

/**
 * Shows llama.cpp's prompt processing in the chat log, as the terminal does:
 * one line per request that fills a bar while the prompt is read, with the part
 * served from the cache in a muted shade, and ends as a summary once done.
 * The silent wait before the first token is otherwise a blank screen.
 */
export function createPromptProgress(
  addLine: (cls: string, text: string) => HTMLElement,
): { handle(message: ServerMessage): void } {
  let line: HTMLElement | null = null;
  let last = 0;
  let fill: HTMLElement;
  let cached: HTMLElement;
  let label: HTMLElement;

  function start(): void {
    line = addLine("progress", "");
    const bar = document.createElement("span");
    bar.className = "progress-bar";
    bar.setAttribute("role", "progressbar");
    cached = document.createElement("span");
    cached.className = "progress-cached";
    fill = document.createElement("span");
    fill.className = "progress-fill";
    bar.append(fill, cached);
    label = document.createElement("span");
    label.className = "progress-label";
    line.append(bar, label);
  }

  return {
    handle(message) {
      const total = message.total ?? 0;
      const processed = message.processed ?? 0;
      if (total <= 0) return;
      // A smaller count than before is a new request (the last one was cut short).
      if (!line || processed < last) start();
      last = processed;
      const done = processed >= total;
      const share = (n: number): string =>
        `${Math.min(100, Math.max(0, (n / total) * 100)).toFixed(1)}%`;
      // Segments left to right: served from the cache, computed so far, still to do.
      const fromCacheTokens = Math.min(message.cache ?? 0, processed);
      cached.style.width = share(fromCacheTokens);
      fill.style.left = share(fromCacheTokens);
      fill.style.width = share(processed - fromCacheTokens);
      line?.querySelector(".progress-bar")?.setAttribute(
        "aria-valuenow",
        String(Math.round((processed / total) * 100)),
      );
      const fromCache = message.cache ? ` · ${message.cache} cached` : "";
      label.textContent = done
        ? `prompt ${total} tokens${fromCache} · ${((message.time_ms ?? 0) / 1000).toFixed(1)} s`
        : `prompt ${processed}/${total}${fromCache}`;
      if (done) {
        line?.classList.add("done");
        line = null;
      }
    },
  };
}
