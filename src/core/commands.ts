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

export type Line =
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
