import type { Message } from "../errors.ts";
import { approxTokens } from "../engine.ts";
import { isSummaryFrame } from "./pins.ts";

/** A summary is never required to be longer than this, however large the conversation it replaces. */
const MIN_SUMMARY_CHARS = 300;

/** The smallest share of the summarized text a summary must be: shorter is an empty or off-task reply. */
const MIN_SUMMARY_SHARE = 0.05;

/**
 * Whether summarizing `toSummarize` would achieve nothing: no messages, or only
 * the frames earlier compactions left (summarizing a summary frees no room and
 * loses detail each time).
 */
export function summarizesNothing(toSummarize: Message[]): boolean {
  return toSummarize.every(isSummaryFrame);
}

/**
 * Why a model's summary of `summarized` must not replace it, or undefined when
 * it can: empty or far too short to stand for the conversation (the model
 * announced a tool call or said nothing), or containing a tool call.
 */
export function summaryProblem(summary: string, summarized: Message[]): string | undefined {
  const text = summary.trim();
  if (text.length === 0) return "the summary was empty";
  if (text.includes("<|tool_call|>")) return "the summary contained a tool call";
  const inputChars = summarized.reduce((n, m) => n + m.content.length, 0);
  const min = Math.min(MIN_SUMMARY_CHARS, Math.floor(inputChars * MIN_SUMMARY_SHARE));
  if (text.length < min)
    return `the summary was too short to stand for the conversation (${text.length} characters)`;
  return undefined;
}

/** Why a compaction whose result is `after` must not replace `before`, or undefined when it shrank the conversation. */
export function growthProblem(before: Message[], after: Message[]): string | undefined {
  const was = approxTokens(before);
  const now = approxTokens(after);
  return now < was
    ? undefined
    : `compaction would not shrink the conversation (${was} -> ${now} tokens)`;
}
