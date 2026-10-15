import { createCutScanner } from "./stream-split.ts";

/** Show `raw` as sanitized HTML when a renderer is given, else verbatim. */
export function showMarkdown(
  element: HTMLElement,
  raw: string,
  renderHtml?: (markdown: string) => string,
): void {
  if (renderHtml) element.innerHTML = renderHtml(raw);
  else element.textContent = raw;
}

/** The finished and the still-open part of a long streaming reply (see `createCutScanner`). */
interface Split {
  frozen: HTMLElement;
  tail: HTMLElement;
  /** How much of the reply is already rendered into `frozen`. */
  length: number;
}

/**
 * Renders a reply while it streams. A long reply renders its finished part
 * (up to `stableCut`) once and only its open tail again on each update, so the
 * cost of a token does not grow with the length of the reply.
 */
export function createStreamRenderer(renderHtml?: (markdown: string) => string): {
  render(element: HTMLElement, raw: string): void;
  /** The reply ended: forget how it was split. */
  reset(): void;
} {
  let split: Split | null = null;
  let scan = createCutScanner();
  return {
    render(element, raw): void {
      if (!renderHtml) {
        element.textContent = raw;
        return;
      }
      const cut = scan(raw);
      if (cut === 0 && !split) {
        element.innerHTML = renderHtml(raw);
        return;
      }
      if (!split) {
        element.textContent = "";
        const frozen = document.createElement("div");
        const tail = document.createElement("div");
        element.append(frozen, tail);
        split = { frozen, tail, length: 0 };
      }
      if (cut > split.length) {
        split.frozen.insertAdjacentHTML("beforeend", renderHtml(raw.slice(split.length, cut)));
        split.length = cut;
      }
      split.tail.innerHTML = renderHtml(raw.slice(split.length));
    },
    reset(): void {
      split = null;
      scan = createCutScanner();
    },
  };
}
