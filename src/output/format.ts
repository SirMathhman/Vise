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
  return models.map((m) => (m === activeModel ? `* ${m} (active)` : `  ${m}`)).join("\n");
}

/** Format the `/note` listing. Each line is a pre-formatted note entry. */
export function formatNoteList(lines: string[]): string {
  if (lines.length === 0) return "no notes";
  return lines.join("\n");
}

/**
 * Render the list of available tools with their current enabled state.
 * Enabled tools are marked with an asterisk; disabled ones are dimmed with
 * `(disabled)`.
 */
export function formatToolList(tools: { name: string; enabled: boolean }[]): string {
  if (tools.length === 0) return "no tools available";
  return tools
    .map((t) => (t.enabled ? `* ${t.name} (enabled)` : `  ${t.name} (disabled)`))
    .join("\n");
}

/** Render the available slash commands as a multi-line help text. */
export function formatHelp(opts: {
  hasModel: boolean;
  hasTools: boolean;
  hasProfile: boolean;
  hasNotes: boolean;
  hasSessions: boolean;
  preTurnHookCount: number;
  postTurnHookCount: number;
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
  if (opts.hasTools) {
    lines.push("/tool            list available tools");
    lines.push("/tool <name> enable|disable  enable or disable a tool");
  }
  if (opts.hasProfile) {
    lines.push(
      "/profile        list available profiles",
      "/profile <name>  set the active profile",
      "/profile default  activate the built-in default profile",
      "/profile init <name>  create a new profile with a placeholder body",
    );
  }
  if (opts.hasNotes) {
    lines.push("/note            list all notes");
    lines.push("/note init <name>  create a new note with a placeholder body");
  }
  if (opts.hasSessions) {
    lines.push("/save            list saved sessions");
    lines.push("/save <name>     save the current conversation under a name");
    lines.push("/resume          list saved sessions");
    lines.push("/resume <name>   resume a previously saved session");
  }
  if (opts.preTurnHookCount > 0) {
    lines.push("");
    lines.push(
      `pre-turn hook${opts.preTurnHookCount > 1 ? "s" : ""}: ${opts.preTurnHookCount} active (output injected before every turn)`,
    );
  }
  if (opts.postTurnHookCount > 0) {
    lines.push(
      `post-turn hook${opts.postTurnHookCount > 1 ? "s" : ""}: ${opts.postTurnHookCount} active (output injected after every turn)`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the list of available profiles, marking the active profile with an
 * asterisk. `activeProfile` is undefined when no profile is set.
 */
export function formatProfileList(profiles: string[], activeProfile: string | undefined): string {
  if (profiles.length === 0) return "no profiles found";
  return profiles.map((p) => (p === activeProfile ? `* ${p} (active)` : `  ${p}`)).join("\n");
}

/**
 * Render the list of saved sessions as a multi-line string. Each line is
 * `  <name>  <savedAt>`. The `auto` entry (the fixed crash-recovery snapshot)
 * is shown first when present.
 */
export function formatSessionList(names: string[]): string {
  if (names.length === 0) return "no saved sessions";
  const lines = names.map((n) => `  ${n}`).join("\n");
  return `saved sessions:\n${lines}\n\n/resume <name>  resume a session\n/save <name>   save the current conversation`;
}
