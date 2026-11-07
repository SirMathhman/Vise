import {
  contextLine,
  helpText,
  parseModelCommand,
  parseThinkingCommand,
  type ExitLine,
  type Line,
  type MessageLine,
} from "../../core/commands.ts";
import {
  clearProfile,
  compactNow,
  setToolEnabled,
  setThinking,
  useProfile,
  type Conversation,
  type Step,
} from "../../core/compaction.ts";
import type { ContextWindow, ModelPorts } from "../../core/messages.ts";
import { checkName, parseProfileCommand } from "../../core/notes.ts";
import {
  decodeSession,
  encodeSession,
  historyMessages,
  parseSessionCommand,
} from "../../core/sessions.ts";
import {
  parseToolsCommand,
  sanitize,
  toolStates,
} from "../../core/tools.ts";
import type { Emit } from "../../protocol/protocol.ts";
import type { SessionPorts } from "../ports.ts";

// The lines that are commands, other than /exit (which ends the loop) and messages.
export type CommandLine = Exclude<Line, ExitLine | MessageLine>;

async function showContext(
  emit: Emit,
  contextWindow: ContextWindow,
  conversation: Conversation,
): Promise<void> {
  let total: number | undefined;
  if (conversation.promptTokens !== undefined) {
    const result = await contextWindow();
    if (result.ok) total = result.value;
    else
      emit({
        kind: "error",
        message: `/context could not read the model's window: ${result.error.message}`,
      });
  }
  emit({
    kind: "notice",
    text: contextLine(conversation.promptTokens, total, conversation.compacted),
  });
}

// Tells the frontend which named sessions can be loaded. Only names that /load accepts are listed.
// A failure is reported, and the session goes on.
export async function announceSessions(ports: SessionPorts, emit: Emit): Promise<void> {
  const listed = await ports.sessions.list();
  if (!listed.ok) {
    emit({ kind: "error", message: `could not list the saved sessions: ${listed.error.message}` });
    return;
  }
  const names = listed.value.filter((name) => checkName(name, "session name").ok);
  emit({ kind: "sessions", names });
}

// Runs one command line and emits what it prints. Returns the step to apply when the command
// changes the conversation (compaction), otherwise undefined.
export async function runCommand(
  input: CommandLine,
  ports: SessionPorts,
  emit: Emit,
  conversation: Conversation,
): Promise<Step | undefined> {
  switch (input.kind) {
    case "context":
      await showContext(emit, ports.contextWindow, conversation);
      return undefined;
    case "compact":
      return compactNow(conversation, ports.reply);
    case "note":
      emit({ kind: "notice", text: await ports.notes(input.words) });
      return undefined;
    case "profile":
      return runProfileCommand(input.words, ports, emit, conversation);
    case "tools":
      return runToolsCommand(input.words, ports, emit, conversation);
    case "session":
      return runSessionCommand(input.words, ports, emit, conversation);
    case "thinking":
      return runThinkingCommand(input.words, emit, conversation);
    case "model":
      await runModelCommand(input.words, ports.models, emit);
      return undefined;
    case "new":
      emit({ kind: "history", messages: [] });
      return {
        conversation: {
          history: [],
          compacted: false,
          disabledTools: ports.disabledTools,
        },
        notice: "started a new conversation",
      };
    case "help": {
      const help = helpText(input.words);
      if (help.ok) emit({ kind: "notice", text: help.value });
      else emit({ kind: "error", message: help.error.message });
      return undefined;
    }
    case "unknown-command":
      emit({ kind: "error", message: `unknown command ${input.command}` });
      return undefined;
  }
}

// Runs /profile: shows the active profile, turns profiles off, or switches to one. A switch only
// records the text, which the next message carries, so the history already sent is not rewritten.
async function runProfileCommand(
  words: string[],
  ports: SessionPorts,
  emit: Emit,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseProfileCommand(words);
  if (!command.ok) {
    emit({ kind: "error", message: command.error.message });
    return undefined;
  }
  if (command.value.kind === "show") {
    emit({
      kind: "notice",
      text: `profile: ${conversation.profile?.name ?? "default"}`,
    });
    return undefined;
  }
  if (command.value.kind === "clear") return clearProfile(conversation);
  const loaded = await ports.profile(command.value.name);
  if (!loaded.ok) {
    emit({ kind: "error", message: loaded.error.message });
    return undefined;
  }
  const allowed = await ports.profileTools(command.value.name);
  if (!allowed.ok) {
    emit({ kind: "error", message: allowed.error.message });
    return undefined;
  }
  const hooks = await ports.profileHooks(command.value.name);
  if (!hooks.ok) {
    emit({ kind: "error", message: hooks.error.message });
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
  ports: SessionPorts,
  emit: Emit,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseToolsCommand(words);
  if (!command.ok) {
    emit({ kind: "error", message: command.error.message });
    return undefined;
  }
  if (command.value.kind === "list") {
    emit({
      kind: "notice",
      text: toolStates(conversation.disabledTools ?? []),
    });
    return undefined;
  }
  const step = setToolEnabled(
    conversation,
    command.value.name,
    command.value.kind === "enable",
  );
  const saved = await ports.saveDisabledTools(
    step.conversation.disabledTools ?? [],
  );
  if (!saved.ok)
    emit({
      kind: "error",
      message: `could not save tool settings: ${saved.error.message}`,
    });
  return step;
}

// Runs /model: lists the models with their context windows, marking the one in use, or switches to a
// listed model. The conversation is kept, so the next request goes to the new model.
async function runModelCommand(
  words: string[],
  models: ModelPorts,
  emit: Emit,
): Promise<void> {
  const command = parseModelCommand(words);
  if (!command.ok) {
    emit({ kind: "error", message: command.error.message });
    return;
  }
  if (command.value.kind === "select") {
    const chosen = await models.select(command.value.name);
    if (chosen.ok)
      emit({ kind: "notice", text: `model: ${sanitize(chosen.value)}` });
    else emit({ kind: "error", message: chosen.error.message });
    return;
  }
  if (command.value.kind === "show") {
    emit({
      kind: "notice",
      text: `model: ${sanitize(models.current())}\nusage: /model search <text> | /model <name>`,
    });
    return;
  }
  const listed = await models.list();
  if (!listed.ok) {
    emit({ kind: "error", message: listed.error.message });
    return;
  }
  // Models whose id contains the text, ignoring letter case, in alphabetical order.
  const snippet = command.value.snippet.toLowerCase();
  const matches = listed.value
    .filter((model) => model.id.toLowerCase().includes(snippet))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (matches.length === 0) {
    emit({
      kind: "notice",
      text: `no model matches ${sanitize(command.value.snippet)}`,
    });
    return;
  }
  const current = models.current();
  for (const model of matches) {
    const mark = model.id === current ? "* " : "  ";
    emit({
      kind: "notice",
      text: `${mark}${sanitize(model.id)}  ${model.contextLength} tokens`,
    });
  }
}

// Runs /thinking: shows how hard the model thinks, or sets it for the following requests.
async function runThinkingCommand(
  words: string[],
  emit: Emit,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseThinkingCommand(words);
  if (!command.ok) {
    emit({ kind: "error", message: command.error.message });
    return undefined;
  }
  if (command.value.kind === "show") {
    emit({
      kind: "notice",
      text: `thinking: ${conversation.thinking ?? "off"}`,
    });
    return undefined;
  }
  return setThinking(conversation, command.value.effort);
}

// Runs /save, /load, and /sessions. A save writes the conversation as it is now. A load replaces the
// conversation with the saved one, and only a file that passes the session format is loaded.
async function runSessionCommand(
  words: string[],
  ports: SessionPorts,
  emit: Emit,
  conversation: Conversation,
): Promise<Step | undefined> {
  const command = parseSessionCommand(words);
  if (!command.ok) {
    emit({ kind: "error", message: command.error.message });
    return undefined;
  }
  if (command.value.kind === "list") {
    const names = await ports.sessions.list();
    if (!names.ok) emit({ kind: "error", message: names.error.message });
    else
      emit({
        kind: "notice",
        text: names.value.length === 0 ? "(no saved sessions)" : names.value.join("\n"),
      });
    return undefined;
  }
  if (command.value.kind === "save") {
    const saved = await ports.sessions.save(
      command.value.name,
      encodeSession(conversation),
    );
    if (saved.ok) {
      emit({ kind: "notice", text: `saved ${command.value.name}` });
      await announceSessions(ports, emit);
    }
    else emit({ kind: "error", message: saved.error.message });
    return undefined;
  }
  const text = await ports.sessions.load(command.value.name);
  if (!text.ok) {
    emit({ kind: "error", message: text.error.message });
    return undefined;
  }
  const loaded = decodeSession(text.value);
  if (!loaded.ok) {
    emit({ kind: "error", message: loaded.error.message });
    return undefined;
  }
  emit({ kind: "history", messages: historyMessages(loaded.value.history) });
  return { conversation: loaded.value, notice: `loaded ${command.value.name}` };
}
