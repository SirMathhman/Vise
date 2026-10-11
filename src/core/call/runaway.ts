/**
 * Spotting a model call that has run away: it keeps writing the same text over
 * and over, or it has written far more than any answer needs. Pure: the edge
 * feeds it the end of what a call has streamed and the server's token count,
 * and decides what to do with the verdict.
 */

/** How much of the end of the text is examined. */
export const WINDOW_CHARS = 2000;
/** Shortest and longest repeating chunk looked for (characters). */
const MIN_PERIOD = 8;
const MAX_PERIOD = 400;
/** A window shorter than this is never called a loop. */
const MIN_EVIDENCE_CHARS = 1500;
/** The share of the window that must continue the repeat. */
const MIN_COVERAGE = 0.985;
/** The chunk must have been written at least this many times. */
const MIN_REPEATS = 10;

/** What repeats at the end of a text. */
export interface Repetition {
  /** Length of the repeating chunk in characters. */
  period: number;
  /** How many times it fits in the examined window. */
  repeats: number;
  /** The share (0..1) of the window that continues the repeat. */
  coverage: number;
  /** The repeating chunk itself (clipped). */
  sample: string;
}

/**
 * The shortest chunk that the end of `text` repeats (allowing a few
 * differences), or undefined when it does not repeat enough to matter.
 */
export function repetition(text: string): Repetition | undefined {
  const tail = text.slice(-WINDOW_CHARS);
  const n = tail.length;
  if (n < MIN_EVIDENCE_CHARS) return undefined;
  for (let period = MIN_PERIOD; period <= MAX_PERIOD; period++) {
    if (n / period < MIN_REPEATS) break;
    let same = 0;
    for (let i = period; i < n; i++) if (tail[i] === tail[i - period]) same++;
    const coverage = same / (n - period);
    if (coverage >= MIN_COVERAGE) {
      return {
        period,
        repeats: Math.floor(n / period),
        coverage,
        sample: tail.slice(n - period).slice(0, 120),
      };
    }
  }
  return undefined;
}

/** What to do about a call. */
export type RunawayVerdict =
  | { stop: false }
  | { stop: true; reason: "loop" | "token_cap"; detail: string };

/** Judge a call from its token count so far, the cap (0 = none) and the end of its text. */
export function runawayVerdict(input: {
  tokens: number;
  cap: number;
  tail: string;
  loopGuard: boolean;
}): RunawayVerdict {
  if (input.cap > 0 && input.tokens > input.cap) {
    return {
      stop: true,
      reason: "token_cap",
      detail: `it wrote more than ${input.cap} tokens`,
    };
  }
  if (!input.loopGuard) return { stop: false };
  const loop = repetition(input.tail);
  if (!loop) return { stop: false };
  return {
    stop: true,
    reason: "loop",
    detail: `the same ${loop.period}-character text repeated about ${loop.repeats} times`,
  };
}
