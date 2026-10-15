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
  /** Which detector found it (`LoopDetector.id`). */
  detector?: string;
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
  const units = proseUnits(text);
  const last = units[units.length - 1];
  if (last === undefined || last.length < MIN_SENTENCE_CHARS) return undefined;
  let repeats = 0;
  for (let i = units.length - 1; i >= 0 && units[i] === last; i--) repeats++;
  if (repeats < MIN_SENTENCE_REPEATS) return undefined;
  return { period: last.length, repeats, coverage: 1, sample: last.slice(0, 120) };
}

/** How many of the last lines are examined for a small vocabulary of lines. */
const VOCAB_UNITS = 16;
/** At most this many different lines among them is a loop (a list of items does not repeat half its lines). */
const VOCAB_MAX_DISTINCT = 8;
/** A line shorter than this (a bracket, a short item) never counts towards a vocabulary loop. */
const VOCAB_MIN_CHARS = 25;

/**
 * The reply text's end, when its last `VOCAB_UNITS` lines are all long and
 * drawn from at most `VOCAB_MAX_DISTINCT` different ones: a model cycling
 * through a few variants of one line ("Let me look at X:" / "Let me check X:")
 * writes loops too long and too uneven for `repetition` (a period over about
 * 200 characters never fits its window enough times) and never the same line
 * twice running, which `repeatedSentence` needs.
 */
export function repeatedLines(text: string): Repetition | undefined {
  const tail = proseUnits(text).slice(-VOCAB_UNITS);
  if (tail.length < VOCAB_UNITS) return undefined;
  if (tail.some((u) => u.length < VOCAB_MIN_CHARS)) return undefined;
  const distinct = new Set(tail).size;
  if (distinct > VOCAB_MAX_DISTINCT) return undefined;
  const sample = tail[tail.length - 1] ?? "";
  return {
    period: Math.round((tail.join("").length / VOCAB_UNITS) * distinct),
    repeats: Math.floor(VOCAB_UNITS / distinct),
    coverage: 1,
    sample: sample.slice(0, 120),
  };
}

/** The reply's prose after its last tool call (never what is inside one), cut into sentences and lines. */
function proseUnits(text: string): string[] {
  const open = text.lastIndexOf("<tool_call>");
  const close = text.lastIndexOf("</tool_call>");
  if (open > close) return [];
  const prose = text.slice(close < 0 ? 0 : close + "</tool_call>".length);
  return prose
    .split(/(?<=[.!?])\s+|\r?\n/)
    .map((u) => u.replace(/\s+/g, " ").trim())
    .filter((u) => u !== "");
}

/** The same tool call this many times in a row ends a call. */
const MIN_CALL_REPEATS = 5;

/**
 * The reply's end, when its last `MIN_CALL_REPEATS` complete tool calls are
 * the same call (whitespace aside). A model stuck emitting one call writes
 * copies that differ in a space or a newline, which shifts the alignment
 * `repetition` needs, so those are compared as normalised calls instead.
 */
export function repeatedCalls(text: string): Repetition | undefined {
  const calls: string[] = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    calls.push((m[1] ?? "").replace(/\s+/g, ""));
  }
  const last = calls[calls.length - 1];
  if (last === undefined) return undefined;
  let repeats = 0;
  for (let i = calls.length - 1; i >= 0 && calls[i] === last; i--) repeats++;
  if (repeats < MIN_CALL_REPEATS) return undefined;
  return { period: last.length, repeats, coverage: 1, sample: last.slice(0, 120) };
}

/** What a detector looks at: the reply's text (tool calls included), or the model's reasoning (where lists repeat legitimately). */
export type LoopScope = "reply" | "reasoning";

/** One way of recognising text that has run away. Add a detector here, not at a call site. */
export interface LoopDetector {
  id: string;
  scopes: readonly LoopScope[];
  find(text: string): Repetition | undefined;
}

/** Every detector, in the order they are tried (cheapest and most specific first). */
export const DETECTORS: readonly LoopDetector[] = [
  { id: "call-repeat", scopes: ["reply"], find: repeatedCalls },
  { id: "window-repeat", scopes: ["reply", "reasoning"], find: repetition },
  { id: "sentence-repeat", scopes: ["reply"], find: repeatedSentence },
  { id: "line-vocabulary", scopes: ["reply"], find: repeatedLines },
];

/** What the end of `text` repeats, by the first detector for `scope` that finds anything. */
export function findLoop(text: string, scope: LoopScope = "reply"): Repetition | undefined {
  for (const d of DETECTORS) {
    if (!d.scopes.includes(scope)) continue;
    const found = d.find(text);
    if (found) return { ...found, detector: d.id };
  }
  return undefined;
}

/** What to do about a call. */
export type RunawayVerdict =
  { stop: false } | { stop: true; reason: "loop" | "token_cap"; detail: string };

/** Judge a call from its token count so far, the cap (0 = none) and the end of its text. */
export function runawayVerdict(input: {
  tokens: number;
  cap: number;
  tail: string;
  loopGuard: boolean;
  /** What `tail` is: the reply (default) or the reasoning. */
  scope?: LoopScope;
  /** Characters of the tool call that is open right now (0 = none) and the most one may have (0 = no limit). */
  openCallChars?: number;
  maxCallChars?: number;
}): RunawayVerdict {
  if (input.cap > 0 && input.tokens > input.cap) {
    return {
      stop: true,
      reason: "token_cap",
      detail: `it wrote more than ${input.cap} tokens`,
    };
  }
  const maxCall = input.maxCallChars ?? 0;
  if (maxCall > 0 && (input.openCallChars ?? 0) > maxCall) {
    return {
      stop: true,
      reason: "token_cap",
      detail: `one tool call ran past ${maxCall} characters without closing`,
    };
  }
  if (!input.loopGuard) return { stop: false };
  const loop = findLoop(input.tail, input.scope ?? "reply");
  if (!loop) return { stop: false };
  return {
    stop: true,
    reason: "loop",
    detail: `the same ${loop.period}-character text repeated about ${loop.repeats} times (${loop.detector})`,
  };
}
