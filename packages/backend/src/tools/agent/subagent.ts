import { AsyncLocalStorage } from "node:async_hooks";
import type { Client, Tool, ToolRunner, TurnCallbacks } from "@vise/core";
import { runSubagent } from "@vise/core";
import { withToolScope } from "./agent-scope.ts";
import { dim } from "../../output/color.ts";
import { formatError } from "../../output/format.ts";
import type { ProfileSource } from "../../repl/session.ts";

/** How many subagents deep the code running now is (0 in the main conversation); follows the work across awaits. */
const subagentDepth = new AsyncLocalStorage<number>();

/** How many subagents deep the code running now is. */
export const currentSubagentDepth = (): number => subagentDepth.getStore() ?? 0;

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
  cwd: string | undefined,
  tools: ToolRunner,
  toolDefs: Tool[],
  callbacks: TurnCallbacks = {},
  withSideSlot?: <T>(operation: () => Promise<T>) => Promise<T>,
  currentAbortSignal?: () => AbortSignal | undefined,
  /** Whether a tool is on by the user's own settings, ignoring the main agent's profile restriction (what a subagent without its own tool list starts from). */
  baselineEnabled?: (name: string) => boolean,
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

    // This subagent sits one level below whoever called it, however deep that is.
    const depth = (subagentDepth.getStore() ?? 0) + 1;
    // A subagent has permissions of its own, never the main agent's: the tools its profile lists, or else
    // the ones the user has enabled (see `agent-scope.ts`).
    const listed = profile === "default" ? undefined : await profileSource.profileTools?.(profile);
    const allowed =
      listed?.ok && listed.value
        ? new Set(listed.value)
        : baselineEnabled
          ? new Set(toolDefs.map((t) => t.function.name).filter(baselineEnabled))
          : undefined;
    const systemMessage = {
      role: "system" as const,
      content:
        cwd === undefined
          ? "This session has no working directory and no file system access."
          : `Working directory: ${cwd}`,
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
      if (callbacks.onSubagentToken) {
        callbacks.onSubagentToken(token, depth);
      } else if (callbacks.onToken) {
        const out = subAtLineStart ? "  " + token : token;
        callbacks.onToken(dim(out));
      }
      subAtLineStart = token.endsWith("\n") && token.length > 0;
    };

    const run = () =>
      runSubagent(client, tools, toolDefs, systemMessage, profileText, task, {
        ...callbacks,
        ...(allowed ? { isToolEnabled: (name: string) => allowed.has(name) } : {}),
        onToken: indentedOnToken,
        onToolCall: (name, _depth, args) => {
          callbacks.onToolCall?.(name, depth, args);
        },
        onToolResult: (name, _depth, result) => {
          callbacks.onToolResult?.(name, depth, result);
        },
        // Forward the parent turn's live abort signal so a subagent's
        // in-flight model call is interrupted together with the parent's
        // turn (the same Ctrl+C that aborts the parent aborts the subagent).
        abort: currentAbortSignal?.(),
      });
    const result = await subagentDepth.run(depth, () =>
      withToolScope(allowed, () => (withSideSlot ? withSideSlot(run) : run())),
    );
    if (!result.ok) return `error: ${formatError(result.error)}`;
    return result.value;
  };
}
