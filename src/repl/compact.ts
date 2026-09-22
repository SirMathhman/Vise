// Conversation compaction: collapses the whole conversation into a single
// summary so a long session doesn't exceed the model's context window.
//
// Compaction is one deliberate call, never an incremental trim. llama.cpp's
// KV-cache reuse depends on each request sharing a stable prefix with the
// one before it; editing history a little every turn (e.g. dropping the
// oldest message each time) would invalidate that cache on every single
// turn. Collapsing everything at once, rarely, pays the cache-miss cost
// once and then leaves the prefix untouched for many turns afterward.
import type { Config } from "../config.ts";
import { chatCompletion } from "../llm/client.ts";
import type { ChatMessage } from "../llm/types.ts";
import { BUILTIN_AGENT, getProfile } from "../profiles.ts";

const SUMMARY_PROMPT =
  "Summarize this conversation so far: the user's goals, decisions made, " +
  "and any unfinished work, so the conversation can continue seamlessly " +
  "without the earlier messages. Be concise but keep concrete details " +
  "(file names, values, decisions) later turns may depend on.";

// The system message appended when /tools disables tools (loop.ts) and
// rebuilt verbatim by compaction below, so the two never drift apart.
export const TOOLS_DISABLED_NOTICE =
  "Your tools were just disabled. You can no longer call tools; if you " +
  "need one, say so and ask the user to re-enable them with /tools on.";

// Replaces `messages` with a fresh, minimal conversation: the active
// profile's instruction, the tools-disabled notice (if applicable), and one
// system message summarizing everything that came before. Costs exactly one
// extra non-streaming, tool-free request (the summary itself isn't shown to
// the user; only the resulting messages array is returned).
export async function compactConversation(
  config: Config,
  model: string,
  messages: ChatMessage[],
  activeProfile: string,
  toolsEnabled: boolean,
): Promise<ChatMessage[]> {
  const { content } = await chatCompletion(
    config,
    model,
    [...messages, { role: "user", content: SUMMARY_PROMPT }],
    [],
  );
  const profile = getProfile(activeProfile) ?? BUILTIN_AGENT;
  const compacted: ChatMessage[] = [
    { role: "system", content: profile.instruction },
  ];
  if (!toolsEnabled) {
    compacted.push({ role: "system", content: TOOLS_DISABLED_NOTICE });
  }
  compacted.push({
    role: "system",
    content: `Summary of the conversation so far:\n\n${content}`,
  });
  return compacted;
}
