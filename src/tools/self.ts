import type { Result } from "../core/errors.ts";
import { formatContext, formatError } from "../output/format.ts";

/**
 * The facts the `self` tool reports about the running agent, gathered at call
 * time so the model sees the live state (the model can change mid-session via
 * `/model`, the active profile via `/profile`, and the context fill changes
 * every turn). The edge constructs one of these per process and threads it
 * into `makeSelfHandler`.
 *
 * The fields are deliberately narrow: they describe "who am I" (backend, model,
 * working directory), "how full am I" (context fill), "who am I acting as"
 * (active profile), and "what runs around each turn" (the hook commands from
 * `.viserc.json`). Everything is read live so a `self` call reflects the
 * current state rather than a construction-time snapshot.
 */
export interface SelfInfo {
  /** The inference backend the agent runs on. */
  backend: string;
  /** The model's identifier, read live (the model can switch via `/model`). */
  model: () => string;
  /** The working directory the agent operates in. */
  cwd: string;
  /** The model's maximum context window in tokens, queried live. */
  contextMax: () => Promise<Result<number>>;
  /** The server's token count of the most recent prompt (how full the context is). */
  lastPromptTokens: () => number | undefined;
  /** The currently active profile name, or undefined when none is set. */
  activeProfile: () => string | undefined;
  /** The pre-turn hook commands from `.viserc.json` (output runs before each turn). */
  preTurnHooks: string[];
  /** The post-turn hook commands from `.viserc.json` (output runs after each turn). */
  postTurnHooks: string[];
}

/**
 * Format the hook command list as a `self` line. An empty list renders as
 * "none"; a list renders one command per line, indented two extra spaces.
 */
function formatHooks(label: string, commands: string[]): string {
  if (commands.length === 0) return `${label}: none`;
  const list = commands.map((c) => `    ${c}`).join("\n");
  return `${label}:\n${list}`;
}

/**
 * Edge handler for the `self` tool. Returns a multi-line summary of the agent's
 * identity and live state. Takes no arguments (the model has everything it
 * needs from the process state). The handler is async because `contextMax`
 * queries the server live.
 */
export function makeSelfHandler(
  info: SelfInfo,
): (args: Record<string, unknown>) => Promise<string> {
  return async (_args: Record<string, unknown>) => {
    const lines: string[] = ["self:"];
    lines.push(`  backend: ${info.backend}`);
    lines.push(`  model: ${info.model()}`);
    lines.push(`  working directory: ${info.cwd}`);

    const max = await info.contextMax();
    if (max.ok) {
      lines.push(`  ${formatContext(info.lastPromptTokens() ?? 0, max.value)}`);
    } else {
      lines.push(`  context: unknown (${formatError(max.error)})`);
    }

    lines.push(`  active profile: ${info.activeProfile() ?? "none"}`);
    lines.push(`  ${formatHooks("pre-turn hooks", info.preTurnHooks)}`);
    lines.push(`  ${formatHooks("post-turn hooks", info.postTurnHooks)}`);

    return lines.join("\n");
  };
}
