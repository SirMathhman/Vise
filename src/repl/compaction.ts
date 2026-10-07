import {
  splitForCompaction,
  splitWithinTurn,
  summarize,
} from "../core/engine.ts";
import type { Message, Result } from "../core/errors.ts";
import type { ContextSource } from "./ports.ts";
import type { CompactionSource } from "./session.ts";

/**
 * How many complete turns (starting from a user message) to keep verbatim after
 * compaction, in addition to the summary. Keeps enough recent context that the
 * conversation continues to feel continuous.
 */
const RECENT_TURNS_TO_KEEP = 2;

/** Compacting inside one long turn: how many of its latest rounds (an assistant message with its tool results) stay verbatim. */
const ROUNDS_TO_KEEP = 10;

/**
 * A successful no-op compaction result: nothing needed to be compacted.
 */
export function okNoop(): Result<string> {
  return { ok: true, value: "nothing to compact" };
}

/**
 * Compact when the last prompt filled `threshold` of the context window (a
 * successful no-op otherwise). `withinTurn` is for the middle of a long turn.
 */
export async function autoCompact(
  source: CompactionSource,
  context: ContextSource,
  threshold: number,
  withinTurn = false,
): Promise<Result<string>> {
  const lastUsed = context.lastPromptTokensUsed();
  if (lastUsed === undefined) return okNoop();
  const max = await context.contextMax();
  if (!max.ok) return max;
  if (lastUsed < threshold * max.value) return okNoop();
  return runCompaction(source, withinTurn);
}

/**
 * Perform compaction on the given session state: split the conversation,
 * summarize the older portion, and replace the conversation with the summary
 * plus the recent turns. On any error the conversation is left untouched and
 * the error is returned. Extracted from the `Session` class so the handlers
 * can be plain module-level functions (matching the `commands.ts` pattern).
 */
export async function runCompaction(
  source: CompactionSource,
  withinTurn = false,
): Promise<Result<string>> {
  const conversation = source.messages().slice(1); // drop the system message
  // Turns are the natural unit, but one turn can hold hundreds of tool calls:
  // then (or when asked to, mid-turn) the split goes inside the turn.
  const byTurns = (): ReturnType<typeof splitForCompaction> =>
    splitForCompaction(conversation, RECENT_TURNS_TO_KEEP);
  const inTurn = (): ReturnType<typeof splitForCompaction> =>
    splitWithinTurn(conversation, ROUNDS_TO_KEEP);
  let split = withinTurn ? inTurn() : byTurns();
  if (split.toSummarize.length === 0) split = withinTurn ? byTurns() : inTurn();
  if (split.toSummarize.length === 0) {
    return okNoop();
  }
  const summary = await summarize(source.client, split.toSummarize);
  if (!summary.ok) {
    // Leave the conversation untouched; report the error.
    return { ok: false, error: summary.error };
  }
  const framed: Message = {
    role: "user",
    content: `Here is a summary of our conversation so far: ${summary.value}`,
  };
  const recent = split.recent;
  source.resetMessages([framed, ...recent]);
  return {
    ok: true,
    value: `compacted ${split.toSummarize.length} messages`,
  };
}
