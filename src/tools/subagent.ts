import type {
  Client,
  Tool,
  ToolRunner,
  TurnCallbacks,
} from "../core/engine.ts";
import { runSubagent } from "../core/engine.ts";
import { dim } from "../output/color.ts";
import { formatError } from "../output/format.ts";
import type { ProfileSource } from "../repl/session.ts";

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
  callbacks: TurnCallbacks = {},
  withPreservedSlotCache?: <T>(operation: () => Promise<T>) => Promise<T>,
  currentAbortSignal?: () => AbortSignal | undefined,
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

    // Indent and dim every line of the subagent's streamed output so it is
    // visually distinct from the parent's own reply. Fixed 2-space indent
    // regardless of nesting depth (a depth-2 subagent is indented the same as
    // a depth-1 one); the dim is cosmetic and does not affect the result
    // returned to the parent model. The driver's onToken clears the
    // thinking/prompt-progress indicator and writes at the current cursor, so
    // we track line-start state ourselves: start at true (subagent output
    // begins at line start), and flip to false after writing a token that does
    // not end in a newline.
    let subAtLineStart = true;
    const indentedOnToken = (token: string) => {
      if (callbacks.onToken) {
        const out = subAtLineStart ? "  " + token : token;
        callbacks.onToken(dim(out));
      }
      subAtLineStart = token.endsWith("\n") && token.length > 0;
    };

    const run = () =>
      runSubagent(client, tools, toolDefs, systemMessage, profileText, task, {
        ...callbacks,
        onToken: indentedOnToken,
        onToolCall: (name) => {
          callbacks.onToolCall?.(name, 1);
        },
        // Forward the parent turn's live abort signal so a subagent's
        // in-flight model call is interrupted together with the parent's
        // turn (the same Ctrl+C that aborts the parent aborts the subagent).
        abort: currentAbortSignal?.(),
      });
    const result = withPreservedSlotCache
      ? await withPreservedSlotCache(run)
      : await run();
    if (!result.ok) return `error: ${formatError(result.error)}`;
    return result.value;
  };
}
