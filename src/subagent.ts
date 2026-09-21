// Subagent execution. A subagent is an isolated LLM conversation seeded
// with a profile's instruction. It has full tool access and can nest
// (a subagent can spawn its own subagent), bounded by a max depth.
//
// The subagent returns its final answer as a string. The caller (the
// run_subagent handler) appends it as a tool result in the parent
// conversation. The subagent's own conversation is discarded on return.
import { chatCompletion } from "./llm/client.ts";
import type { ChatMessage, ToolContext } from "./llm/types.ts";
import { getProfile } from "./profiles.ts";

const MAX_DEPTH = 5;
const MAX_TOOL_ROUNDS = 8;

// Runs an isolated subagent conversation. Seeds a fresh conversation with
// the profile's instruction and the task as a user message. Loops on
// model calls and tool dispatch until the model produces a final answer
// or the round cap is hit. Returns the final answer string.
export async function runSubagent(
  ctx: ToolContext,
  profileName: string,
  task: string,
): Promise<string> {
  const profile = getProfile(profileName);
  if (!profile) throw new Error(`Unknown profile: ${profileName}`);
  if (ctx.depth >= MAX_DEPTH)
    throw new Error(`Max subagent depth (${MAX_DEPTH}) reached`);

  const messages: ChatMessage[] = [
    { role: "system", content: profile.instruction },
    { role: "user", content: task },
  ];

  const subCtx: ToolContext = { ...ctx, depth: ctx.depth + 1 };

  for (let round = 0; ; round++) {
    if (round >= MAX_TOOL_ROUNDS)
      throw new Error("Subagent stopped after max tool rounds");
    const reply = await chatCompletion(
      ctx.config,
      ctx.model,
      messages,
      ctx.tools,
    );
    const toolCalls = reply.toolCalls;
    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: reply.content || null,
        tool_calls: toolCalls,
      });
      for (const tc of toolCalls) {
        const args = JSON.parse(tc.function.arguments) as Record<
          string,
          unknown
        >;
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: await subCtx.dispatch(tc.function.name, args, subCtx),
        });
      }
      continue;
    }
    return reply.content;
  }
}
