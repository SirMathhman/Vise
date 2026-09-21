// The run_subagent tool handler. Delegates a task to a subagent that runs
// an isolated conversation seeded with the named profile's instruction.
// The subagent has full tool access and can nest, bounded by depth.
// Returns the subagent's final answer as a string (the tool result).
import { runSubagent } from "../subagent.ts";
import type { ToolContext } from "../tools.ts";

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
