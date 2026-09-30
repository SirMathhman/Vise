import { splitForCompaction, summarize } from "../core/engine.ts";
import type { Client } from "../core/engine.ts";
import type { CompactionSource } from "./session.ts";
import type { Message, Result } from "../core/errors.ts";

/**
 * How many complete turns (starting from a user message) to keep verbatim after
 * compaction, in addition to the summary. Keeps enough recent context that the
 * conversation continues to feel continuous.
 */
const RECENT_TURNS_TO_KEEP = 2;

/**
 * A successful no-op compaction result: nothing needed to be compacted.
 */
export function okNoop(): Result<string> {
  return { ok: true, value: "nothing to compact" };
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
): Promise<Result<string>> {
  const conversation = source.messages().slice(1); // drop the system message
  const split = splitForCompaction(conversation, RECENT_TURNS_TO_KEEP);
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
