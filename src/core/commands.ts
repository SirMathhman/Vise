import type { ReasoningEffort } from "./messages.ts";
import { err, ok, type Result } from "./result.ts";

export interface ExitLine {
  kind: "exit";
}

export interface ContextLine {
  kind: "context";
}

export interface UnknownCommandLine {
  kind: "unknown-command";
  command: string;
}

export interface CompactLine {
  kind: "compact";
}

// A /note command. words are the words after /note, split on whitespace.
export interface NoteLine {
  kind: "note";
  words: string[];
}

// A /profile command. words are the words after /profile, split on whitespace.
export interface ProfileLine {
  kind: "profile";
  words: string[];
}

// A /tools command. words are the words after /tools, split on whitespace.
export interface ToolsLine {
  kind: "tools";
  words: string[];
}

// A session command: /save, /load, or /sessions. words are the words after the slash, split on whitespace.
export interface SessionLine {
  kind: "session";
  words: string[];
}

export interface MessageLine {
  kind: "message";
  text: string;
}

// A /thinking command. words are the words after /thinking, split on whitespace.
export interface ThinkingLine {
  kind: "thinking";
  words: string[];
}

// A /model command. words are the words after /model, split on whitespace.
export interface ModelLine {
  kind: "model";
  words: string[];
}

// A /help command. words are the words after /help, split on whitespace.
export interface HelpLine {
  kind: "help";
  words: string[];
}

export type Line =
  | HelpLine
  | ModelLine
  | ThinkingLine
  | ExitLine
  | ContextLine
  | CompactLine
  | NoteLine
  | ProfileLine
  | ToolsLine
  | SessionLine
  | UnknownCommandLine
  | MessageLine;

// Decides what a line means. Commands are matched on the trimmed line. Other
// lines starting with "/" are rejected, and everything else is a message for
// the model, sent exactly as typed.
export function classifyLine(line: string): Line {
  const command = line.trim();
  if (command === "/exit") return { kind: "exit" };
  if (command === "/context") return { kind: "context" };
  if (command === "/compact") return { kind: "compact" };
  if (command === "/note" || command.startsWith("/note ")) {
    return { kind: "note", words: command.split(/\s+/).slice(1) };
  }
  if (command === "/tools" || command.startsWith("/tools ")) {
    return { kind: "tools", words: command.split(/\s+/).slice(1) };
  }
  if (/^\/(save|load|sessions)(\s|$)/.test(command)) {
    return { kind: "session", words: command.slice(1).split(/\s+/) };
  }
  if (command === "/profile" || command.startsWith("/profile ")) {
    return { kind: "profile", words: command.split(/\s+/).slice(1) };
  }
  if (command === "/thinking" || command.startsWith("/thinking ")) {
    return { kind: "thinking", words: command.split(/\s+/).slice(1) };
  }
  if (command === "/model" || command.startsWith("/model ")) {
    return { kind: "model", words: command.split(/\s+/).slice(1) };
  }
  if (command === "/help" || command.startsWith("/help ")) {
    return { kind: "help", words: command.split(/\s+/).slice(1) };
  }
  if (command.startsWith("/")) return { kind: "unknown-command", command };
  return { kind: "message", text: line };
}

export interface ShowThinkingCommand {
  kind: "show";
}

// Sets the effort: `undefined` turns thinking off.
export interface SetThinkingCommand {
  kind: "set";
  effort: ReasoningEffort | undefined;
}

export type ThinkingCommand = ShowThinkingCommand | SetThinkingCommand;

// Reads the words after /thinking: nothing shows the setting, and off, low, medium, or high sets it.
export function parseThinkingCommand(words: string[]): Result<ThinkingCommand> {
  const [level] = words;
  if (words.length === 0) return ok({ kind: "show" });
  if (words.length !== 1)
    return err(new Error("usage: /thinking [off | low | medium | high]"));
  if (level === "off") return ok({ kind: "set", effort: undefined });
  if (level === "low" || level === "medium" || level === "high")
    return ok({ kind: "set", effort: level });
  return err(new Error("usage: /thinking [off | low | medium | high]"));
}

export interface ShowModelCommand {
  kind: "show";
}

export interface SearchModelsCommand {
  kind: "search";
  snippet: string;
}

export interface SelectModelCommand {
  kind: "select";
  name: string;
}

export type ModelCommand =
  ShowModelCommand | SearchModelsCommand | SelectModelCommand;

const MODEL_USAGE = "usage: /model | /model search <text> | /model <name>";

// Reads the words after /model: nothing shows the model in use, `search` followed by text lists the
// models whose id contains it, and a single name chooses a model.
export function parseModelCommand(words: string[]): Result<ModelCommand> {
  const [first] = words;
  if (words.length === 0) return ok({ kind: "show" });
  if (first === "search") {
    if (words.length < 2) return err(new Error(MODEL_USAGE));
    return ok({ kind: "search", snippet: words.slice(1).join(" ") });
  }
  if (words.length === 1 && first !== undefined)
    return ok({ kind: "select", name: first });
  return err(new Error(MODEL_USAGE));
}

export function contextLine(
  used: number | undefined,
  total: number | undefined,
  compacted: boolean,
): string {
  if (used === undefined) {
    return compacted
      ? "context: size unknown since the last compaction"
      : "context: no request sent yet";
  }
  return `context: ${used} / ${total ?? "unknown"} tokens`;
}

// The answers an approval question takes. "exit" is /exit typed at the question.
export type ApprovalAnswer = "approve" | "refuse" | "exit";

// The answer a line typed at an approval question gives: /exit ends the session, y or yes approves,
// and any other line refuses.
export function answerOfLine(line: string): ApprovalAnswer {
  const text = line.trim();
  if (text === "/exit") return "exit";
  return /^y(es)?$/i.test(text) ? "approve" : "refuse";
}

// What /help says about one command: its usage, a summary for the list, and a fuller description.
interface CommandHelp {
  usage: string;
  summary: string;
  detail: string;
}

// Every command the classifier recognises. Each name is a key, so a command without an entry is a
// compile error; the test checks each name against classifyLine.
export type HelpName =
  | "exit"
  | "context"
  | "compact"
  | "note"
  | "profile"
  | "tools"
  | "thinking"
  | "model"
  | "save"
  | "load"
  | "sessions"
  | "help";

const COMMAND_HELP: Record<HelpName, CommandHelp> = {
  exit: {
    usage: "/exit",
    summary: "ends the session",
    detail: "Ends the session. Nothing more is sent to the model.",
  },
  context: {
    usage: "/context",
    summary: "shows how much of the model's context window is used",
    detail:
      "Shows the prompt tokens the provider counted for the last request, out of the model's context window. After a compaction the size is unknown until the next request.",
  },
  compact: {
    usage: "/compact",
    summary: "summarizes the conversation to free up context",
    detail:
      "Asks the model for a summary of the whole conversation, and keeps the summary and the last six messages. Compaction also happens by itself at 80% of the context window.",
  },
  note: {
    usage: "/note new <category> <name> | /note list [category]",
    summary: "creates a note, or lists the notes",
    detail:
      "Notes are kept in the notes folder, grouped by category. `new` creates a note with its scaffold, and `list` shows the notes, optionally in one category. Nothing here is sent to the model.",
  },
  profile: {
    usage: "/profile [name | default]",
    summary: "shows, switches, or turns off the profile",
    detail:
      "With no argument, shows the profile in use. With a name, switches to that profile: its text goes with the next message. `default` turns profiles off.",
  },
  tools: {
    usage: "/tools [enable | disable <tool>]",
    summary: "lists the tools, or switches one on or off",
    detail:
      "With no argument, lists each tool as on or off. `enable` or `disable` with a tool name switches it. The change applies from the next request and is saved to the settings file.",
  },
  thinking: {
    usage: "/thinking [off | low | medium | high]",
    summary: "shows or sets how hard the model thinks",
    detail:
      "With no argument, shows the setting. `off`, `low`, `medium`, or `high` sets it for the requests that follow.",
  },
  model: {
    usage: "/model [search <text> | <name>]",
    summary: "shows, searches, or switches the model",
    detail:
      "With no argument, shows the model in use. `search <text>` lists the models whose id contains the text. A model name switches to that model, keeps the conversation, and is saved for the next session.",
  },
  save: {
    usage: "/save <name>",
    summary: "saves the conversation as a session",
    detail:
      "Writes the conversation to .vise/sessions/<name>.json, replacing a session of the same name.",
  },
  load: {
    usage: "/load <name>",
    summary: "loads a saved session",
    detail:
      "Replaces the conversation with the session saved as .vise/sessions/<name>.json, and applies that session's switched-off tools for this session only.",
  },
  sessions: {
    usage: "/sessions",
    summary: "lists the saved sessions",
    detail: "Lists the names of the sessions saved with /save.",
  },
  help: {
    usage: "/help [command]",
    summary: "lists the commands, or describes one",
    detail:
      "With no argument, lists every command. With a command name, such as /help model, describes that command.",
  },
};

const HELP_USAGE = "usage: /help | /help <command>";

// The text /help prints: every command on its own line when no name is given, otherwise the usage and
// description of the named command. A name that is not a command, or more than one word, is an error.
export function helpText(words: string[]): Result<string> {
  if (words.length > 1) return err(new Error(HELP_USAGE));
  const [name] = words;
  if (name === undefined) return ok(helpList());
  const wanted = name.replace(/^\//, "");
  if (!isHelpName(wanted)) {
    return err(new Error(`no command ${name}; /help lists them`));
  }
  const found = COMMAND_HELP[wanted];
  return ok(`${found.usage}\n${found.detail}`);
}

function isHelpName(name: string): name is HelpName {
  return Object.hasOwn(COMMAND_HELP, name);
}

function helpList(): string {
  const names = Object.keys(COMMAND_HELP) as HelpName[];
  const width = Math.max(...names.map((name) => COMMAND_HELP[name].usage.length));
  return names
    .map((name) => {
      const { usage, summary } = COMMAND_HELP[name];
      return `${usage.padEnd(width)}  ${summary}`;
    })
    .join("\n");
}
