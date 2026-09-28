import type { ViseError } from "../core/errors.ts";

/** Render a structured error as a single line for the terminal. */
export function formatError(err: ViseError): string {
  if (err.kind === "http") {
    return `vise: HTTP ${err.status} from server: ${err.body}`;
  } else if (err.kind === "network") {
    return `vise: ${err.cause}`;
  } else {
    return `vise: ${err.body}`;
  }
}

/**
 * Render the context fill as a single line for the terminal, e.g.
 * `context: 45 / 141568 tokens (0%)`. `usedTokens` is the server's own count
 * of the last prompt sent; `maxTokens` is the model's window from the server.
 */
export function formatContext(usedTokens: number, maxTokens: number): string {
  const pct = maxTokens > 0 ? Math.min(100, (usedTokens / maxTokens) * 100) : 0;
  const pctLabel = pct >= 1 ? pct.toFixed(1) : pct.toFixed(2);
  return `context: ${usedTokens} / ${maxTokens} tokens (${pctLabel}%)`;
}

/**
 * Render a failed auto-compaction as a single stderr line. Distinguishes the
 * case where the live window read failed (no max known) from a summarize
 * failure, so the user can tell which thing broke.
 */
export function formatCompactionFailure(err: ViseError): string {
  if (err.kind === "http") {
    return `vise: auto-compact skipped (HTTP ${err.status}): ${err.body}`;
  } else if (err.kind === "network") {
    return `vise: auto-compact skipped (network): ${err.cause}`;
  } else {
    return `vise: auto-compact skipped: ${err.body}`;
  }
}

/**
 * Render the list of available models, marking the active model with an asterisk.
 */
export function formatModelList(models: string[], activeModel: string): string {
  if (models.length === 0) return "no models available";
  return models
    .map((m) => (m === activeModel ? `* ${m} (active)` : `  ${m}`))
    .join("\n");
}

/** Render the available slash commands as a multi-line help text. */
export function formatHelp(opts: {
  hasModel: boolean;
  hasProfile: boolean;
  hasPreTurnHook: boolean;
}): string {
  const lines = [
    "/exit          exit the REPL",
    "/help          show this help",
    "/context       show context window usage",
    "/compact       compact the conversation now",
  ];
  if (opts.hasModel) {
    lines.push(
      "/model          list available models",
      "/model <name>   switch to the named model",
    );
  }
  if (opts.hasProfile) {
    lines.push(
      "/profile        list available profiles",
      "/profile <name> set the active profile",
    );
  }
  if (opts.hasPreTurnHook) {
    lines.push("");
    lines.push("pre-turn hook: active (output injected before every turn)");
  }
  return lines.join("\n");
}

/**
 * Render the list of available profiles, marking the active profile with an
 * asterisk. `activeProfile` is undefined when no profile is set.
 */
export function formatProfileList(
  profiles: string[],
  activeProfile: string | undefined,
): string {
  if (profiles.length === 0) return "no profiles found";
  return profiles
    .map((p) => (p === activeProfile ? `* ${p} (active)` : `  ${p}`))
    .join("\n");
}
