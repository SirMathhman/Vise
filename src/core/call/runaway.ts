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

/** A sentence shorter than this is never called a loop (lists and brackets repeat legitimately). */
const MIN_SENTENCE_CHARS = 40;
/** The same sentence this many times in a row ends a call. */
const MIN_SENTENCE_REPEATS = 4;

/**
 * The reply text's end, when it is one sentence (or line) written
 * `MIN_SENTENCE_REPEATS` times in a row: much sooner than `repetition` can
 * tell, which needs a whole window. Text inside a tool call is never judged
 * (it may legitimately repeat), only what follows the last one.
 */
export function repeatedSentence(text: string): Repetition | undefined {
  const open = text.lastIndexOf("<tool_call>");
  const close = text.lastIndexOf("</tool_call>");
  if (open > close) return undefined;
  const prose = text.slice(close < 0 ? 0 : close + "</tool_call>".length);
  const units = prose
    .split(/(?<=[.!?])\s+|\r?\n/)
    .map((u) => u.replace(/\s+/g, " ").trim())
    .filter((u) => u !== "");
  const last = units[units.length - 1];
  if (last === undefined || last.length < MIN_SENTENCE_CHARS) return undefined;
  let repeats = 0;
  for (let i = units.length - 1; i >= 0 && units[i] === last; i--) repeats++;
  if (repeats < MIN_SENTENCE_REPEATS) return undefined;
  return { period: last.length, repeats, coverage: 1, sample: last.slice(0, 120) };
}

/** What a call's reply text repeats at its end: a whole-window repeat, else a repeated sentence. */
export function findLoop(text: string): Repetition | undefined {
  return repetition(text) ?? repeatedSentence(text);
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
  /** Also judge repeated sentences: for the reply text, not for reasoning (whose lists repeat). */
  sentences?: boolean;
}): RunawayVerdict {
  if (input.cap > 0 && input.tokens > input.cap) {
    return {
      stop: true,
      reason: "token_cap",
      detail: `it wrote more than ${input.cap} tokens`,
    };
  }
  if (!input.loopGuard) return { stop: false };
  const loop = input.sentences ? findLoop(input.tail) : repetition(input.tail);
  if (!loop) return { stop: false };
  return {
    stop: true,
    reason: "loop",
    detail: `the same ${loop.period}-character text repeated about ${loop.repeats} times`,
  };
}
