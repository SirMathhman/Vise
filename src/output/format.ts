import type { GoalEvent } from "../repl/turn/goal-loop.ts";
import type { ViseError } from "../core/errors.ts";
import type { SessionEntry } from "../repl/ports.ts";

/** Render a structured error as a single line for the terminal. */
export function formatError(err: ViseError): string {
  if (err.kind === "http") {
    return `vise: HTTP ${err.status} from server: ${err.body}`;
  } else if (err.kind === "network") {
    return `vise: ${err.cause}`;
  } else if (err.kind === "interrupted") {
    return "vise: interrupted";
  } else if (err.kind === "storage") {
    const hint = err.hint ? ` (${err.hint})` : "";
    return `vise: could not ${err.op} ${err.path}: ${err.cause}${hint}`;
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
  } else if (err.kind === "interrupted") {
    return "vise: auto-compact skipped: interrupted";
  } else if (err.kind === "storage") {
    return `vise: auto-compact skipped: could not ${err.op} ${err.path}: ${err.cause}`;
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

/**
 * Render the list of available `reasoning_effort` levels, marking the active
 * one with an asterisk. `active` is the effective level in use (`default` when
 * nothing is set, since an unset value behaves like the template default).
 */
export function formatReasoningList(
  levels: readonly string[],
  active: string,
): string {
  if (levels.length === 0) return "no reasoning efforts available";
  return levels
    .map((level) => (level === active ? `* ${level} (active)` : `  ${level}`))
    .join("\n");
}

/** Format the `/note` listing: lines already grouped by category. */
export function formatNoteList(lines: string[]): string {
  if (lines.length === 0) return "no notes";
  return lines.join("\n");
}

/**
 * Render the list of available tools with their current enabled state.
 * Enabled tools are marked with an asterisk; disabled ones are dimmed with
 * `(disabled)`.
 */
export function formatToolList(
  tools: { name: string; enabled: boolean; category?: string }[],
): string {
  if (tools.length === 0) return "no tools available";
  const row = (t: { name: string; enabled: boolean }): string =>
    t.enabled ? `* ${t.name} (enabled)` : `  ${t.name} (disabled)`;
  // Tools without categories (e.g. a minimal controller) keep the flat form.
  if (tools.every((t) => t.category === undefined)) {
    return tools.map(row).join("\n");
  }
  const groups = new Map<string, typeof tools>();
  for (const t of tools) {
    const key = t.category ?? "other";
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }
  return [...groups]
    .flatMap(([category, group]) => [`[${category}]`, ...group.map(row)])
    .join("\n");
}

/**
 * Format hook commands (numbered, by phase) for `/hooks`. `scope` replaces the
 * default "output injected before/after every turn" wording, e.g. for a
 * profile's own hooks.
 */
export function formatHooks(
  hooks: { pre: string[]; post: string[] },
  scope?: string,
): string {
  const section = (label: string, commands: string[]): string =>
    commands.length === 0
      ? `${label}: none`
      : `${label}:\n${commands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`;
  return [
    section(
      `pre-turn hooks (${scope ?? "output injected before every turn"})`,
      hooks.pre,
    ),
    section(
      `post-turn hooks (${scope ?? "output injected after every turn"})`,
      hooks.post,
    ),
  ].join("\n");
}

/** Render the available slash commands as a multi-line help text. */
export function formatHelp(opts: {
  hasModel: boolean;
  hasReasoning: boolean;
  hasTools: boolean;
  hasProfile: boolean;
  hasNotes: boolean;
  hasWorkflows: boolean;
  hasSessions: boolean;
  hasAudit?: boolean;
  hasMcp?: boolean;
  preTurnHookCount: number;
  postTurnHookCount: number;
}): string {
  const lines = [
    "/exit          exit the REPL",
    "/help          show this help",
    "/context       show context window usage",
    "/compact       compact the conversation now",
    "/new           start a new conversation (the old one stays saved)",
    "/hooks         show the configured pre/post-turn hook commands",
    '/hooks add pre|post "<command>"  add a hook (saved to .viserc.json)',
    "/hooks remove pre|post <number>  remove a hook",
    "/hooks profile <name> [add|remove pre|post ...]  hooks that run only with a profile",
  ];
  if (opts.hasModel) {
    lines.push(
      "/model          list available models",
      "/model <name>   switch to the named model",
    );
  }
  if (opts.hasReasoning) {
    lines.push(
      "/reasoning         list available reasoning efforts",
      "/reasoning <level> set the active reasoning effort",
    );
  }
  lines.push(
    "/burst [on|off]  think once to plan, then run tool calls without thinking",
  );
  lines.push(
    "/goal [on|off|clear|log [turns]]  check each turn against a goal and keep going until it is met (log: why each turn ended)",
    "/image <path>   attach an image file to your next message (clear: /image clear)",
  );
  if (opts.hasTools) {
    lines.push("/tool            list available tools");
    lines.push(
      "/tool <name|category> enable|disable  enable or disable a tool or a whole category",
    );
  }
  if (opts.hasMcp) lines.push("/mcp            list MCP servers and their state", "/mcp restart <name>  reconnect a server (new tools appear after a page reload or restart)");
  if (opts.hasProfile) {
    lines.push(
      "/profile        list available profiles",
      "/profile <name>  set the active profile",
      "/profile default  activate the built-in default profile",
      "/profile init <name>  create a new profile with a placeholder body",
      "/profile <name> tools [a,b|all]  show or set a profile's tool whitelist",
    );
  }
  if (opts.hasNotes) {
    lines.push("/note            list all notes by scope and category");
    lines.push(
      "/note init [--global] <name> [category]  create a new note (project unless --global) with a placeholder body",
    );
  }
  if (opts.hasWorkflows) {
    lines.push("/workflow                 list available workflows");
    lines.push("/workflow <name> [input]  run a workflow");
    lines.push("/<name> [input]           run the workflow or send the note called <name>");
    lines.push("/workflow init <name>    create a project workflow");
    lines.push("/workflow init --global <name>  create a global workflow");
  }
  if (opts.hasSessions) {
    lines.push("/save            list saved sessions");
    lines.push("/save <name>     save the current conversation under a name");
    lines.push("/resume          list saved sessions");
    lines.push("/resume <name>   resume a previously saved session");
    lines.push("/delete <name>   delete a saved session");
    lines.push("/search <text>   find saved sessions that mention the text");
  }
  if (opts.hasAudit) {
    lines.push("/audit           what the agent did in this conversation");
    lines.push("/audit tools|models|errors|hooks   details");
    lines.push("/audit search <text>   search every recorded conversation");
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

/** Format workflow names, showing scope and which definition wins lookup. */
export function formatWorkflowList(
  workflows: { name: string; scope: "project" | "global"; active: boolean }[],
): string {
  if (workflows.length === 0) return "no workflows found";
  return workflows
    .map((workflow) => {
      const marker = workflow.active ? "*" : " ";
      const active = workflow.active ? " (active)" : " (shadowed)";
      return `${marker} ${workflow.name} [${workflow.scope}]${active}`;
    })
    .join("\n");
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

/**
 * Render the list of saved sessions as a multi-line string. Each line is
 * `  <name>  (<id>)`: the display name and the uuid that /resume and /delete
 * take. Auto-saved sessions (named from the conversation's first message) and
 * renamed ones are listed together, sorted by name.
 */
export function formatSessionList(entries: SessionEntry[]): string {
  if (entries.length === 0) return "no saved sessions";
  const lines = entries.map((e) => `  ${e.name}  (${e.id})`).join("\n");
  return `saved sessions:
${lines}

/resume <id>  resume a session (an id prefix is enough)
/save <name>  name the current session and save it
/delete <id>  delete a saved session`;
}

/** How a goal event is shown: one line, and whether it is good news, a nudge or a request for the user. */
export interface GoalLine {
  text: string;
  level: "info" | "ok" | "warn" | "ask";
}

/** The line shown for a goal event (undefined for events that show nothing: the goal itself, the setting changing, or a plain continue). */
export function formatGoalEvent(event: GoalEvent): GoalLine | undefined {
  // The goal the agent derived is its own working note: not shown. Only how it ended is.
  if (event.kind === "goal" || event.kind === "setting") return undefined;
  const detail = event.detail === "" ? "" : ` — ${event.detail}`;
  if (event.verdict === "yes") {
    return { text: `✓ goal met${detail}`, level: "ok" };
  }
  if (event.verdict === "unknown") {
    return {
      text: `⚠ goal check unavailable${detail} (the goal is kept; the turn was not judged)`,
      level: "warn",
    };
  }
  if (event.verdict === "blocked") {
    return { text: `✋ needs you${detail}`, level: "ask" };
  }
  // Sending the model back to work is routine: not worth the user's attention.
  if (event.continuing) return undefined;
  return { text: `↻ not done yet${detail}`, level: "warn" };
}
