import type { Writable } from "node:stream";
import {
  contextLine,
  parseModelCommand,
  parseThinkingCommand,
  type ExitLine,
  type Line,
  type MessageLine,
} from "../core/commands.ts";
import {
  clearProfile,
  compactNow,
  setToolEnabled,
  setThinking,
  useProfile,
  type Conversation,
  type Step,
} from "../core/compaction.ts";
import type {
  ContextWindow,
  ModelPorts,
  ReplyRequest,
  ToolCall,
} from "../core/messages.ts";
import { parseProfileCommand, type HookPoint, type ProfileHook } from "../core/notes.ts";
import type { Result } from "../core/result.ts";
import { decodeSession, encodeSession, parseSessionCommand, type SessionStore } from "../core/sessions.ts";
import { parseToolsCommand, sanitize, toolStates, type Approve } from "../core/tools.ts";

async function showContext(
  output: Writable,
  contextWindow: ContextWindow,
  conversation: Conversation,
): Promise<void> {
  let total: number | undefined;
  if (conversation.promptTokens !== undefined) {
    const result = await contextWindow();
    if (result.ok) total = result.value;
    else output.write(`error: /context could not read the model's window: ${result.error.message}\n`);
  }
  output.write(`${contextLine(conversation.promptTokens, total, conversation.compacted)}\n`);
}

// Every port the session uses. All are required; a caller that omits one fails to compile.
export interface ReplPorts {
  reply(request: ReplyRequest): AsyncIterable<Result<string>>;
  contextWindow(): Promise<Result<number>>;
  tools(call: ToolCall, approve: Approve, offered: string[]): Promise<string>;
  notes(words: string[]): Promise<string>;
  profile(name: string): Promise<Result<string>>;
  // The tools a profile allows, undefined when it has no whitelist.
  profileTools(name: string): Promise<Result<string[] | undefined>>;
  // The hooks a profile adds at its points.
  profileHooks(name: string): Promise<Result<ProfileHook[]>>;
  // Runs the hooks of one point. Their output goes to the next message.
  hooks(point: HookPoint, profile?: string[]): Promise<Result<string>>;
  // The tools switched off when the session starts, and the writer for the settings file.
  disabledTools: string[];
  saveDisabledTools(names: string[]): Promise<Result<void>>;
  // Where /save and /load keep sessions.
  sessions: SessionStore;
  // The model in use, and the models /model may switch to.
  models: ModelPorts;
  // Text sent ahead of the first message of the session (the AGENTS.md file), if any.
  instructions?: string;
}

// The lines that are commands, other than /exit (which ends the loop) and messages.
export type CommandLine = Exclude<Line, ExitLine | MessageLine>;

// Runs one command line and writes what it prints. Returns the step to apply when the command
// changes the conversation (compaction), otherwise undefined.
export async function runCommand(
  input: CommandLine,
  ports: ReplPorts,
  output: Writable,
  conversation: Conversation,
): Promise<Step | undefined> {
  switch (input.kind) {
    case "context":
      await showContext(output, ports.contextWindow, conversation);
      return undefined;
    case "compact":
      return compactNow(conversation, ports.reply);
    case "note":
      output.write(`${await ports.notes(input.words)}\n`);
      return undefined;
    case "profile":
      return runProfileCommand(input.words, ports, output, conversation);
    case "tools":
      return runToolsCommand(input.words, ports, output, conversation);
    case "session":
      return runSessionCommand(input.words, ports, output, conversation);
    case "thinking":
      return runThinkingCommand(input.words, output, conversation);
    case "model":
      await runModelCommand(input.words, ports.models, output);
      return undefined;
    case "unknown-command":
      output.write(`error: unknown command ${input.command}\n`);
      return undefined;
  }
}

// Runs /profile: shows the active profile, turns profiles off, or switches to one. A switch only
// records the text, which the next message carries, so the history already sent is not rewritten.
async function runProfileCommand(
  words: string[],
  ports: ReplPorts,
  output: Writable,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseProfileCommand(words);
  if (!command.ok) {
    output.write(`error: ${command.error.message}\n`);
    return undefined;
  }
  if (command.value.kind === "show") {
    output.write(`profile: ${conversation.profile?.name ?? "default"}\n`);
    return undefined;
  }
  if (command.value.kind === "clear") return clearProfile(conversation);
  const loaded = await ports.profile(command.value.name);
  if (!loaded.ok) {
    output.write(`error: ${loaded.error.message}\n`);
    return undefined;
  }
  const allowed = await ports.profileTools(command.value.name);
  if (!allowed.ok) {
    output.write(`error: ${allowed.error.message}\n`);
    return undefined;
  }
  const hooks = await ports.profileHooks(command.value.name);
  if (!hooks.ok) {
    output.write(`error: ${hooks.error.message}\n`);
    return undefined;
  }
  return useProfile(conversation, {
    name: command.value.name,
    text: loaded.value,
    tools: allowed.value,
    hooks: hooks.value,
  });
}

// Runs /tools: lists the tools and whether each is on, or switches one on or off. The change applies
// from the next request and is saved to the settings file, which the next session reads.
async function runToolsCommand(
  words: string[],
  ports: ReplPorts,
  output: Writable,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseToolsCommand(words);
  if (!command.ok) {
    output.write(`error: ${command.error.message}\n`);
    return undefined;
  }
  if (command.value.kind === "list") {
    output.write(`${toolStates(conversation.disabledTools ?? [])}\n`);
    return undefined;
  }
  const step = setToolEnabled(conversation, command.value.name, command.value.kind === "enable");
  const saved = await ports.saveDisabledTools(step.conversation.disabledTools ?? []);
  if (!saved.ok) output.write(`error: could not save tool settings: ${saved.error.message}\n`);
  return step;
}

// Runs /model: lists the models with their context windows, marking the one in use, or switches to a
// listed model. The conversation is kept, so the next request goes to the new model.
async function runModelCommand(words: string[], models: ModelPorts, output: Writable): Promise<void> {
  const command = parseModelCommand(words);
  if (!command.ok) {
    output.write(`error: ${command.error.message}\n`);
    return;
  }
  if (command.value.kind === "select") {
    const chosen = await models.select(command.value.name);
    output.write(chosen.ok ? `model: ${sanitize(chosen.value)}\n` : `error: ${chosen.error.message}\n`);
    return;
  }
  if (command.value.kind === "show") {
    output.write(`model: ${sanitize(models.current())}\nusage: /model search <text> | /model <name>\n`);
    return;
  }
  const listed = await models.list();
  if (!listed.ok) {
    output.write(`error: ${listed.error.message}\n`);
    return;
  }
  // Models whose id contains the text, ignoring letter case, in alphabetical order.
  const snippet = command.value.snippet.toLowerCase();
  const matches = listed.value
    .filter((model) => model.id.toLowerCase().includes(snippet))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (matches.length === 0) {
    output.write(`no model matches ${sanitize(command.value.snippet)}\n`);
    return;
  }
  const current = models.current();
  for (const model of matches) {
    const mark = model.id === current ? "* " : "  ";
    output.write(`${mark}${sanitize(model.id)}  ${model.contextLength} tokens\n`);
  }
}

// Runs /thinking: shows how hard the model thinks, or sets it for the following requests.
async function runThinkingCommand(words: string[], output: Writable, conversation: Conversation): Promise<Step | undefined> {
  const command = parseThinkingCommand(words);
  if (!command.ok) {
    output.write(`error: ${command.error.message}\n`);
    return undefined;
  }
  if (command.value.kind === "show") {
    output.write(`thinking: ${conversation.thinking ?? "off"}\n`);
    return undefined;
  }
  return setThinking(conversation, command.value.effort);
}

// Runs /save, /load, and /sessions. A save writes the conversation as it is now. A load replaces the
// conversation with the saved one, and only a file that passes the session format is loaded.
async function runSessionCommand(
  words: string[],
  ports: ReplPorts,
  output: Writable,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseSessionCommand(words);
  if (!command.ok) {
    output.write(`error: ${command.error.message}\n`);
    return undefined;
  }
  if (command.value.kind === "list") {
    const names = await ports.sessions.list();
    if (!names.ok) output.write(`error: ${names.error.message}\n`);
    else output.write(`${names.value.length === 0 ? "(no saved sessions)" : names.value.join("\n")}\n`);
    return undefined;
  }
  if (command.value.kind === "save") {
    const saved = await ports.sessions.save(command.value.name, encodeSession(conversation));
    output.write(saved.ok ? `saved ${command.value.name}\n` : `error: ${saved.error.message}\n`);
    return undefined;
  }
  const text = await ports.sessions.load(command.value.name);
  if (!text.ok) {
    output.write(`error: ${text.error.message}\n`);
    return undefined;
  }
  const loaded = decodeSession(text.value);
  if (!loaded.ok) {
    output.write(`error: ${loaded.error.message}\n`);
    return undefined;
  }
  return { conversation: loaded.value, notice: `loaded ${command.value.name}` };
}

