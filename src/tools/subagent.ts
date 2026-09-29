import { runSubagent } from "../core/engine.ts";
import type { Client, Tool, ToolRunner } from "../core/engine.ts";
import type { ProfileSource } from "../repl/session.ts";
import { formatError } from "../output/format.ts";

/**
 * The built-in "default" profile. Every subagent that does not name a custom
 * profile receives this text as its defining instructions, so there is always
 * a persona even when `profiles/` is empty.
 */
const DEFAULT_PROFILE =
  "You are a focused subagent. Complete the task given to you and report your final result concisely.";

/**
 * Creates the handler for the `run_subagent` tool. The subagent runs a fresh,
 * isolated conversation (its own system message and profile) inside the
 * parent's tool loop, using the same `ToolRunner` and `Tool[]` as the parent,
 * so it may in turn call `run_subagent` and spawn its own subagents.
 *
 * The `profile` argument is required. `"default"` resolves to the built-in
 * `DEFAULT_PROFILE`; any other name is loaded from `profiles/<name>.md` via
 * the provided `ProfileSource`. The subagent's final assistant text is
 * returned as the tool result.
 *
 * Edge: performs `ProfileSource` I/O (loading named profiles). The core
 * `runSubagent` does no I/O of its own.
 */
export function makeSubagentHandler(
  client: Client,
  profileSource: ProfileSource,
  cwd: string,
  tools: ToolRunner,
  toolDefs: Tool[],
): (args: Record<string, unknown>) => Promise<string> {
  return async (args) => {
    const task = args["task"];
    const profile = args["profile"];
    if (typeof task !== "string" || task.trim() === "") {
      return "error: run_subagent requires a non-empty 'task' argument";
    }
    if (typeof profile !== "string" || profile.trim() === "") {
      return "error: run_subagent requires a 'profile' argument";
    }

    let profileText: string;
    if (profile === "default") {
      profileText = DEFAULT_PROFILE;
    } else {
      const loaded = await profileSource.loadProfile(profile);
      if (!loaded.ok) return `error: ${formatError(loaded.error)}`;
      profileText = loaded.value;
    }

    const systemMessage = {
      role: "system" as const,
      content: `Working directory: ${cwd}`,
    };
    const result = await runSubagent(
      client,
      tools,
      toolDefs,
      systemMessage,
      profileText,
      task,
    );
    if (!result.ok) return `error: ${formatError(result.error)}`;
    return result.value;
  };
}
