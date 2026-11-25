import type { ModelSummary } from "common";
import { RESERVED_REPLY_TOKENS, estimateTokens } from "common";
import type { toolDefinitions } from "../tools";
import type { UpstreamMessage } from "../openrouter";

/**
 * What the backend knows about the model answering a reply. The model can read it through the
 * get_model_info tool.
 */
export interface ModelSelf {
  /** The OpenRouter model id, such as openai/gpt-4o. */
  id: string;
  /** The model's display name. */
  name: string;
  /** The model's context window, in tokens. */
  contextLength: number;
  /** Tokens reserved for the reply, not available to the conversation. */
  replyReserveTokens: number;
  /** Tokens of the conversation budget still free when the reply started, estimated. */
  remainingBudgetTokens: number;
  /** Names of the tools the model may call in this reply. */
  toolNames: string[];
}

/**
 * Builds the facts the model can read about itself for one reply. The budget left counts
 * everything the upstream request carries: the system context and the tool definitions as well
 * as the conversation.
 *
 * @param info The model's entry from the model list.
 * @param upstream The messages as sent upstream, including the system context.
 * @param tools The tools offered in the request. Empty for none.
 * @param limit The conversation budget in tokens.
 * @returns The facts for this reply.
 */
export function buildModelSelf(
  info: ModelSummary,
  upstream: UpstreamMessage[],
  tools: typeof toolDefinitions,
  limit: number,
): ModelSelf {
  const carried =
    estimateTokens(JSON.stringify(upstream)) +
    estimateTokens(JSON.stringify(tools));
  return {
    id: info.id,
    name: info.name,
    contextLength: info.contextLength,
    replyReserveTokens: RESERVED_REPLY_TOKENS,
    remainingBudgetTokens: Math.max(0, limit - carried),
    toolNames: tools.map((tool) => tool.function.name),
  };
}
