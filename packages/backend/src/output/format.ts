import { type CommandNeed, helpLines } from "../repl/command-catalog.ts";
import type { GoalEvent } from "../repl/turn/goal-loop.ts";
import type { ViseError } from "@vise/core";
import {
  describeToolHook,
  type ToolHookEntry,
} from "@vise/core";
import type { SessionEntry } from "../repl/ports.ts";

/**
 * What an HTTP error body says, as one short sentence: the `error.message` of
 * the JSON an OpenAI-style API (llama.cpp, vLLM) answers with, else the
 * body as it came. A few statuses get what to do about them.
 */
export function httpReason(status: number, body: string): string {
  let message = body.trim();
  try {
    const parsed: unknown = JSON.parse(body);
    const error = (parsed as { error?: unknown } | null)?.error;
    const text =
      typeof error === "string"
        ? error
        : (error as { message?: unknown } | null | undefined)?.message;
    if (typeof text === "string" && text.trim() !== "") message = text.trim();
  } catch {
    // Not JSON: the body is the message.
  }
  const hints: Record<number, string> = {
    401: "check the API key in settings",
    402: "the account is out of credits",
    404: "no such model or endpoint; run /model to see the choices",
    429: "rate limited; try again in a moment",
  };
  const hint = hints[status];
  return hint ? `${message} (${hint})` : message;
}

/** Render a structured error as a single line for the terminal. */
export function formatError(err: ViseError): string {
  if (err.kind === "http") {
    return `vise: HTTP ${err.status} from server: ${httpReason(err.status, err.body)}`;
  } else if (err.kind === "network") {
    return `vise: ${err.cause}`;
  } else if (err.kind === "interrupted") {
    return "vise: interrupted";
  } else if (err.kind === "runaway") {
    return `vise: stopped a runaway model call (${err.purpose}, ${err.tokens} tokens): ${err.detail}. See /audit calls.`;
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
    return `vise: auto-compact skipped (HTTP ${err.status}): ${httpReason(err.status, err.body)}`;
  } else if (err.kind === "network") {
    return `vise: auto-compact skipped (network): ${err.cause}`;
  } else if (err.kind === "interrupted") {
    return "vise: auto-compact skipped: interrupted";
  } else if (err.kind === "runaway") {
    return `vise: auto-compact skipped: model call stopped (${err.detail})`;
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
  hooks: {
    pre: string[];
    post: string[];
    preTool?: ToolHookEntry[];
    postTool?: ToolHookEntry[];
  },
  scope?: string,
): string {
  const section = (label: string, commands: string[]): string =>
    commands.length === 0
      ? `${label}: none`
      : `${label}:\n${commands.map((c, i) => `  ${i + 1}. ${c}`).join("\n")}`;
  const sections = [
    section(
      `pre-turn hooks (${scope ?? "output injected before every turn"})`,
      hooks.pre,
    ),
    section(
      `post-turn hooks (${scope ?? "output injected after every turn"})`,
      hooks.post,
    ),
  ];
  // Tool hooks are global only; a profile's listing has none.
  if (hooks.preTool !== undefined) {
    sections.push(
      section(
        "pre-tool hooks (run before a tool call; exit code 2 blocks it)",
        hooks.preTool.map(describeToolHook),
      ),
    );
  }
  if (hooks.postTool !== undefined) {
    sections.push(
      section(
        "post-tool hooks (run after a tool call; output joins its result)",
        hooks.postTool.map(describeToolHook),
      ),
    );
  }
  return sections.join("\n");
}

/** Render the available slash commands as a multi-line help text (the lines come from the command catalog). */
export function formatHelp(opts: {
  available: ReadonlySet<CommandNeed>;
  /** The web page also answers `/steer` and `/queue`. */
  web?: boolean;
  preTurnHookCount: number;
  postTurnHookCount: number;
}): string {
  const lines = helpLines(opts.available, opts.web === true);
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

/** `  saved 2026-10-10 14:03 UTC` for an ISO time; nothing when there is none or it is not one. */
function savedAt(iso: string | undefined): string {
  const match = iso ? /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso) : null;
  return match ? `  saved ${match[1]} ${match[2]} UTC` : "";
}

/**
 * Render the list of saved sessions as a multi-line string. Each line is
 * `  <name>  (<id>)`, then `  saved <yyyy-mm-dd hh:mm> UTC` when the time is
 * known: the display name, the uuid that /resume and /delete take, and when it
 * was last saved (the web page parses these lines). Auto-saved sessions (named
 * from the conversation's first message) and renamed ones are listed together,
 * sorted by name.
 */
export function formatSessionList(entries: SessionEntry[]): string {
  if (entries.length === 0) return "no saved sessions";
  const lines = entries
    .map((e) => `  ${e.name}  (${e.id})${savedAt(e.updated)}`)
    .join("\n");
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
