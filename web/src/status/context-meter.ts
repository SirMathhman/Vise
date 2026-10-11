/** The numbers in a context report: "context: 12345 / 141568 tokens (8.72%)". */
export interface ContextFill {
  used: number;
  max: number;
  percent: number;
}

/** Read a context report; undefined when it is not one. Pure. */
export function parseContextFill(text: string): ContextFill | undefined {
  const match = /(\d[\d,]*)\s*\/\s*(\d[\d,]*)\s*tokens?\s*\(([\d.]+)%\)/.exec(text);
  if (!match) return undefined;
  const num = (s: string | undefined): number => Number((s ?? "").replaceAll(",", ""));
  return { used: num(match[1]), max: num(match[2]), percent: Number(match[3]) };
}

/** 950 → "950", 12345 → "12.3k", 1234567 → "1.23M". Pure. */
export function compactCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1).replace(/\.?0+$/, "")}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
}

/** From this fill the bar offers "Compact". */
const COMPACT_FROM = 75;
/** From this fill the bar turns red (the server compacts by itself at 90%). */
const WARN_FROM = 90;

/**
 * The context bar under the chat: a thin meter and "12.3k / 141.6k tokens",
 * the whole report in its tooltip, a "Compact" button once the conversation
 * fills three quarters of the window, red from 90%.
 */
export function showContextFill(text: string): void {
  const button = document.getElementById("context");
  const fill = document.getElementById("context-fill");
  const label = document.getElementById("context-text");
  const compact = document.getElementById("compact-btn");
  if (!button || !fill || !label || !compact) return;
  const parsed = parseContextFill(text);
  button.title = `${text}\nClick for what fills it (/context)`;
  if (!parsed) {
    label.textContent = text;
    return;
  }
  const share = Math.min(100, Math.max(0, parsed.percent));
  label.textContent = `${compactCount(parsed.used)} / ${compactCount(parsed.max)} tokens · ${Math.round(share)}%`;
  fill.style.width = `${share}%`;
  button.classList.toggle("warning", share >= WARN_FROM);
  compact.classList.toggle("hidden", share < COMPACT_FROM);
}
