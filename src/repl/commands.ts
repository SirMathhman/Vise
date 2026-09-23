// The command registry: parse a `/` line, dispatch to a handler, return a
// result. No fetch, no stdin/stdout. A command uses its arguments plus the
// state it is handed; it returns lines to render and, optionally, a new
// active model or one-shot model input. It never prints or reads input.
import type { ChatMessage, ModelInfo, Usage } from "../llm/types.ts";
import { getNote } from "../notes.ts";
import { createProfile, getProfile, listProfiles } from "../profiles.ts";
import type { SessionState } from "../session.ts";
import { tools } from "../tools.ts";

export type CommandResult = {
  lines: string[];
  isError?: boolean;
  setModel?: string;
  setProfile?: string;
  setTools?: boolean;
  newMessages?: ChatMessage[];
  newSession?: SessionState;
  modelInput?: string;
};

export type CommandContext = {
  model: string;
  activeProfile: string;
  toolsEnabled: boolean;
  listModels: () => Promise<ModelInfo[]>;
  persistModel: (name: string) => void;
  lastUsage: Usage | undefined;
  getContextSize: () => Promise<number | undefined>;
  compact: () => Promise<ChatMessage[]>;
  saveNamedSession: (name: string) => string | null;
  loadNamedSession: (name: string) => SessionState | null;
  listNamedSessions: () => string[];
  newConversation: (
    activeProfile: string,
    toolsEnabled: boolean,
  ) => SessionState;
  createNote: (name: string) => string | null;
};

export async function runCommand(
  text: string,
  ctx: CommandContext,
): Promise<CommandResult> {
  const [command, ...rest] = text.split(/\s+/);
  if (command === "/profile") {
    return runProfileCommand(rest, ctx);
  }
  if (command === "/tool") {
    return runToolCommand(rest);
  }
  if (command === "/tools") {
    return runToolsCommand(rest, ctx.toolsEnabled);
  }
  if (command === "/context") {
    return runContextCommand(ctx);
  }
  if (command === "/compact") {
    return runCompactCommand(ctx);
  }
  if (command === "/save") {
    return runSaveCommand(rest, ctx);
  }
  if (command === "/load") {
    return runLoadCommand(rest, ctx);
  }
  if (command === "/sessions") {
    return runSessionsCommand(ctx);
  }
  if (command === "/new") {
    return runNewCommand(ctx);
  }
  if (command === "/note") {
    return runNoteCommand(rest, ctx);
  }
  const noteName = command.slice(1);
  const note =
    command !== "/model" && noteName.length > 0 && !/[\\/]/.test(noteName)
      ? getNote(noteName)
      : null;
  if (note) {
    const instructions = text.slice(command.length).trim();
    return {
      lines: [`note> ${note.name}`],
      modelInput: [
        `Use this note as context for the request:\n\n${note.content}`,
        instructions ? `Further instructions:\n${instructions}` : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }
  if (command !== "/model") {
    return {
      lines: [
        `Unknown command: ${command}. Try /model, /profile, /tool, /tools, ` +
          "/context, /compact, /save, /load, /sessions, /new, or /note new.",
      ],
      isError: true,
    };
  }
  let models: ModelInfo[];
  try {
    models = await ctx.listModels();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      lines: [`error: could not list models: ${detail}`],
      isError: true,
    };
  }
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    const lines = ["Available models:"];
    for (const m of models) {
      const marks = [
        m.id === ctx.model ? "current" : "",
        m.loaded ? "loaded" : "",
      ];
      const suffix = marks.filter(Boolean).join(", ");
      lines.push(`  ${m.id}${suffix ? ` (${suffix})` : ""}`);
    }
    return { lines };
  }
  if (!models.some((m) => m.id === name)) {
    const lines = [`error: unknown model: ${name}`, "Available models:"];
    for (const m of models) lines.push(`  ${m.id}`);
    return { lines, isError: true };
  }
  try {
    ctx.persistModel(name);
    return { lines: [`model> ${name} (saved to .env.local)`], setModel: name };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { lines: [`model> ${name} (not saved: ${detail})`], setModel: name };
  }
}

// /profile handler. With no argument, lists all available profiles and marks
// the active one. With `new <name>`, creates a profile stub file. With a
// name, switches to that profile by returning setProfile (the loop appends
// a new system message; history is never altered).
function runProfileCommand(rest: string[], ctx: CommandContext): CommandResult {
  if (rest.length === 1 && rest[0] === "new") {
    return {
      lines: ["/profile new requires a name: /profile new <name>"],
      isError: true,
    };
  }
  if (rest.length > 1 && rest[0] === "new") {
    const name = rest.slice(1).join(" ").trim();
    const err = createProfile(name);
    if (err) return { lines: [`error: ${err}`], isError: true };
    return { lines: [`created profile: ${name}`] };
  }
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    const profiles = listProfiles();
    const lines = ["Available profiles:"];
    for (const p of profiles) {
      const mark = p.name === ctx.activeProfile ? " (active)" : "";
      lines.push(`  ${p.name}${mark}`);
    }
    return { lines };
  }
  const profile = getProfile(name);
  if (!profile) {
    const profiles = listProfiles();
    const lines = [`error: unknown profile: ${name}`, "Available profiles:"];
    for (const p of profiles) lines.push(`  ${p.name}`);
    return { lines, isError: true };
  }
  return {
    lines: [`profile> ${profile.name}`],
    setProfile: profile.name,
  };
}

// /tool handler. With no argument, lists the names of every tool the model
// can call. With a name, shows that tool's details (description and declared
// arguments). Read-only; it never mutates session state.
function runToolCommand(rest: string[]): CommandResult {
  const name = rest.join(" ").trim();
  if (name.length > 0) {
    const tool = tools.find((t) => t.function.name === name);
    if (!tool) {
      const lines = [`error: unknown tool: ${name}`, "Available tools:"];
      for (const t of tools) lines.push(`  ${t.function.name}`);
      return { lines, isError: true };
    }
    const lines = [`${tool.function.name}:`, tool.function.description];
    const props = tool.function.parameters.properties;
    const keys = Object.keys(props);
    if (keys.length > 0) {
      lines.push("Arguments:");
      for (const key of keys) {
        const description = props[key]?.description;
        lines.push(`  ${key}${description ? ` — ${description}` : ""}`);
      }
    }
    return { lines };
  }
  const lines = ["Available tools:"];
  for (const tool of tools) {
    lines.push(`  ${tool.function.name}`);
  }
  return { lines };
}

// /tools handler. With no argument, reports whether tools are enabled. With
// `on` or `off`, sets the tools-enabled flag by returning setTools; the loop
// applies the flag and, when tools are turned off, appends a system message
// telling the model its tools were just disabled. Read-only otherwise; it
// never runs a tool or mutates session state directly.
function runToolsCommand(rest: string[], enabled: boolean): CommandResult {
  const arg = rest.join(" ").trim().toLowerCase();
  if (arg.length === 0) {
    return {
      lines: [enabled ? "tools> enabled" : "tools> disabled"],
    };
  }
  if (arg === "off" || arg === "disable" || arg === "disabled") {
    return {
      lines: ["tools> disabled"],
      setTools: false,
    };
  }
  if (arg === "on" || arg === "enable" || arg === "enabled") {
    return {
      lines: ["tools> enabled"],
      setTools: true,
    };
  }
  return {
    lines: [
      `unknown /tools argument: ${arg}`,
      enabled ? "tools> enabled" : "tools> disabled",
      "Usage: /tools [on|off]",
    ],
    isError: true,
  };
}

// /context handler. Reports the token count currently sitting in the
// conversation (from the most recent response's usage) and, when the server
// reports its context window (GET /props), that count as a percentage of it.
// Read-only; it never mutates session state.
async function runContextCommand(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.lastUsage) {
    return { lines: ["No turns yet in this conversation."] };
  }
  const used = ctx.lastUsage.total_tokens;
  const lines = [`context> ${used} tokens used`];
  try {
    const size = await ctx.getContextSize();
    if (size) {
      const pct = ((used / size) * 100).toFixed(1);
      lines[0] = `context> ${used} / ${size} tokens (${pct}%)`;
    } else {
      lines.push("(server did not report a context window size)");
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    lines.push(`(could not fetch context window size: ${detail})`);
  }
  return { lines };
}

// /compact handler. Collapses the conversation into a single summary via
// ctx.compact() (bound in loop.ts to compactConversation), and returns the
// result as newMessages so the loop can replace its conversation state.
// Skips the model call entirely when there's nothing to compact yet.
async function runCompactCommand(ctx: CommandContext): Promise<CommandResult> {
  if (!ctx.lastUsage) {
    return { lines: ["Nothing to compact yet."] };
  }
  try {
    const newMessages = await ctx.compact();
    return { lines: ["compact> conversation summarized"], newMessages };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { lines: [`error: could not compact: ${detail}`], isError: true };
  }
}

// /save handler. Saves the current conversation under the given name to
// .vise/sessions/<name>.json. The name must be a valid filename (alphanumerics,
// dots, hyphens, underscores). With no argument, shows usage.
function runSaveCommand(rest: string[], ctx: CommandContext): CommandResult {
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    return {
      lines: ["Usage: /save <name>"],
      isError: true,
    };
  }
  const err = ctx.saveNamedSession(name);
  if (err) {
    return { lines: [`error: could not save: ${err}`], isError: true };
  }
  return { lines: [`saved session: ${name}`] };
}

// /load handler. Loads a named session from .vise/sessions/<name>.json and
// replaces the current conversation with it. With no argument, shows usage.
// With an unknown name, lists available sessions.
function runLoadCommand(rest: string[], ctx: CommandContext): CommandResult {
  const name = rest.join(" ").trim();
  if (name.length === 0) {
    return {
      lines: ["Usage: /load <name>"],
      isError: true,
    };
  }
  const state = ctx.loadNamedSession(name);
  if (!state) {
    const sessions = ctx.listNamedSessions();
    if (sessions.length === 0) {
      return {
        lines: [`error: no saved sessions found`],
        isError: true,
      };
    }
    const lines = [`error: unknown session: ${name}`, "Available sessions:"];
    for (const s of sessions) lines.push(`  ${s}`);
    return { lines, isError: true };
  }
  return {
    lines: [`loaded session: ${name}`],
    newSession: state,
  };
}

// /sessions handler. Lists all saved session names. Read-only.
function runSessionsCommand(ctx: CommandContext): CommandResult {
  const sessions = ctx.listNamedSessions();
  if (sessions.length === 0) {
    return { lines: ["No saved sessions."] };
  }
  const lines = ["Saved sessions:"];
  for (const s of sessions) lines.push(`  ${s}`);
  return { lines };
}

// /note new <name> creates a blank note template without replacing any
// existing note. The startup index includes it after the next restart.
function runNoteCommand(rest: string[], ctx: CommandContext): CommandResult {
  if (rest.length !== 2 || rest[0] !== "new" || !rest[1]) {
    return { lines: ["Usage: /note new <name>"], isError: true };
  }
  const name = rest[1];
  const error = ctx.createNote(name);
  if (error) return { lines: [`error: ${error}`], isError: true };
  return {
    lines: [
      `created note: ${name}`,
      `edit .agents/notes/${name}.md to add content`,
    ],
  };
}

// /new handler. Starts a fresh conversation seeded with the active profile's
// instruction, keeping the current profile and tools flag. Returns a
// newSession so the loop replaces the conversation state.
function runNewCommand(ctx: CommandContext): CommandResult {
  const state = ctx.newConversation(ctx.activeProfile, ctx.toolsEnabled);
  return {
    lines: ["conversation cleared"],
    newSession: state,
  };
}
