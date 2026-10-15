import { config } from "../../config.ts";
import {
  approxTokens,
  pinUserWords,
  renderPins,
  SUMMARY_FRAME_PREFIX,
  splitForCompaction,
  splitWithinTurn,
  summarize,
} from "@vise/core";
import type { Message, Result } from "@vise/core";
import type { Client, Tool } from "@vise/core";
import type { ContextSource } from "../ports.ts";
import type { CompactionSource } from "../session.ts";

/**
 * How many complete turns (starting from a user message) to keep verbatim after
 * compaction, in addition to the summary. Keeps enough recent context that the
 * conversation continues to feel continuous.
 */

/** Compacting inside one long turn: how many of its latest rounds (an assistant message with its tool results) stay verbatim. */

/** Compacting inside a turn: the verbatim tail may take at most this share of the context window. */

/** Inside a long turn the context can grow by a whole page read per round, so compaction starts earlier than between turns. */

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
  /** Tokens added since the last prompt was measured (the last round's reply and tool results). */
  pending = 0,
): Promise<Result<string>> {
  const lastUsed = context.lastPromptTokensUsed();
  if (lastUsed === undefined) return okNoop();
  const max = await context.contextMax();
  // Mid-turn, not being able to measure just means no compaction this round.
  if (!max.ok) return withinTurn ? okNoop() : max;
  if (lastUsed + pending < threshold * max.value) return okNoop();
  // The verbatim tail may take a quarter of the window, so what is summarized (and the request to do it) fits.
  return runCompaction(source, withinTurn, config.tailShare * max.value);
}

/** Tokens added to the conversation since the last model call: its reply and the tool results that followed. */
export function addedSinceLastCall(messages: Message[]): number {
  let from = messages.length - 1;
  while (from > 0 && messages[from]?.role !== "assistant") from--;
  return approxTokens(messages.slice(from));
}

/**
 * Upkeep for a conversation that has no session around it (a subagent's): compact
 * it in place when the last prompt passed the threshold. Returns a reason to end
 * the turn when compacting fails, since going on would only overflow the window.
 */
export async function compactInPlace(
  client: Client,
  context: ContextSource,
  messages: Message[],
  threshold: number,
  toolDefs: Tool[],
): Promise<string | undefined> {
  const source: CompactionSource = {
    client,
    messages: () => [...messages],
    prefix: () => {
      const system = messages[0];
      return system?.role === "system" ? { system, tools: toolDefs } : undefined;
    },
    resetMessages: (body) => {
      messages.splice(1, messages.length, ...body); // the first message is the system message
    },
  };
  const result = await autoCompact(source, context, threshold, true, addedSinceLastCall(messages));
  return result.ok
    ? undefined
    : "Stopped: the conversation is too long and could not be compacted.";
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
  tailBudget = Number.POSITIVE_INFINITY,
): Promise<Result<string>> {
  const conversation = source.messages().slice(1); // drop the system message
  // Turns are the natural unit, but one turn can hold hundreds of tool calls:
  // then (or when asked to, mid-turn) the split goes inside the turn.
  const byTurns = (): ReturnType<typeof splitForCompaction> =>
    splitForCompaction(conversation, config.recentTurnsToKeep);
  const inTurn = (): ReturnType<typeof splitForCompaction> =>
    splitWithinTurn(conversation, config.roundsToKeep, tailBudget);
  let split = withinTurn ? inTurn() : byTurns();
  if (split.toSummarize.length === 0) split = withinTurn ? byTurns() : inTurn();
  if (split.toSummarize.length === 0) {
    return okNoop();
  }
  const summary = await summarize(source.client, split.toSummarize, source.prefix?.());
  if (!summary.ok) {
    // Leave the conversation untouched; report the error.
    return { ok: false, error: summary.error };
  }
  // The user's own words are copied, not paraphrased, so a standing instruction cannot be lost in the summary.
  const pins = pinUserWords(split.toSummarize);
  const block = renderPins(pins);
  const framed: Message = {
    role: "user",
    content: `${SUMMARY_FRAME_PREFIX} ${summary.value}${
      block
        ? `

${block}`
        : ""
    }`,
  };
  const recent = split.recent;
  source.audit?.record({
    kind: "compaction",
    summarized: split.toSummarize.length,
    kept: recent.length,
    summary: summary.value,
  });
  source.resetMessages([framed, ...recent]);
  return {
    ok: true,
    value: `compacted ${split.toSummarize.length} messages`,
  };
}
