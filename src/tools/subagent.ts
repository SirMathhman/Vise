// The run_subagent tool: schema and handler. Delegates a task to a subagent
// that runs an isolated conversation seeded with the named profile's
// instruction. The subagent has full tool access and can nest, bounded by
// depth. Returns the subagent's final answer as a string (the tool result).
import type { Tool, ToolContext } from "../llm/types.ts";
import { runSubagent } from "../subagent.ts";

export const run_subagent_schema: Tool = {
  type: "function",
  function: {
    name: "run_subagent",
    description:
      "Delegate a task to a subagent, which runs an isolated conversation seeded with the named profile's instructions. The subagent has full tool access and can spawn its own subagents. Returns the subagent's final answer as a string. Use this to hand off a self-contained task to a specialized persona (profile).",
    parameters: {
      type: "object",
      properties: {
        profile: {
          type: "string",
          description:
            "The name of the profile to run the subagent as. The profile's instruction becomes the subagent's system message.",
        },
        task: {
          type: "string",
          description:
            "The task to hand to the subagent. The subagent sees only this text plus its profile instruction; it does not see the parent conversation.",
        },
      },
      required: ["profile", "task"],
    },
  },
};

export const run_subagent = async (
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<string> => {
  const profile = String(args.profile ?? "");
  const task = String(args.task ?? "");
  if (profile.length === 0 || task.length === 0)
    return "run_subagent requires both 'profile' and 'task' arguments.";
  try {
    return await runSubagent(ctx, profile, task);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};
