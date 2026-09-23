// Subagent execution. A subagent is an isolated LLM conversation seeded
// with a profile's instruction. It has full tool access and can nest
// (a subagent can spawn its own subagent), bounded by a max depth.
//
// The subagent returns its final answer as a string. The caller (the
// run_subagent handler) appends it as a tool result in the parent
// conversation. The subagent's own conversation is discarded on return.
import { runToolRounds } from "./llm/turns.ts";
import type { ChatMessage, ToolContext } from "./llm/types.ts";
import { getProfile } from "./profiles.ts";

const MAX_DEPTH = 5;

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

  // Intersect the subagent profile's tool whitelist with the parent's tool
  // set. If the profile declares a whitelist, only tools present in BOTH
  // are available. If the profile has no whitelist, the parent's set is
  // used as-is.
  const subTools = ctx.tools.filter(
    (tool) =>
      tool.function.name !== "ask_user" &&
      (!profile.tools || profile.tools.includes(tool.function.name)),
  );

  const messages: ChatMessage[] = [
    { role: "system", content: profile.instruction },
    { role: "user", content: task },
  ];

  const subCtx: ToolContext = {
    ...ctx,
    depth: ctx.depth + 1,
    tools: subTools,
    askQuestion: undefined,
  };

  const reply = await runToolRounds(
    ctx.config,
    ctx.model,
    messages,
    subTools,
    (name, args) => subCtx.dispatch(name, args, subCtx),
  );
  return reply.content;
}
