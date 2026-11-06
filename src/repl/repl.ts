import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine, contextLine, type ExitLine, type Line, type MessageLine } from "../core/commands.ts";
import {
  clearProfile,
  compactIfNeeded,
  compactNow,
  enabledTools,
  recordUsage,
  setToolEnabled,
  useProfile,
  type Conversation,
  type Step,
} from "../core/compaction.ts";
import type { ChatMessage, ContextWindow, Reply, ToolCall, Usage } from "../core/messages.ts";
import { parseProfileCommand, type NoteRunner, type ProfileLoader } from "../core/notes.ts";
import {
  describeToolCall,
  parseToolsCommand,
  sanitize,
  toolStates,
  type Approve,
  type SaveDisabledTools,
  type ToolRunner,
} from "../core/tools.ts";
import { err, ok, type Result } from "../core/result.ts";

export type { ContextWindow, Reply } from "../core/messages.ts";

export async function* echoReply(messages: ChatMessage[]): AsyncGenerator<Result<string>> {
  yield ok(`echo: ${messages.at(-1)?.content ?? ""}`);
}

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
  reply: Reply;
  contextWindow: ContextWindow;
  tools: ToolRunner;
  notes: NoteRunner;
  profile: ProfileLoader;
  // The tools switched off when the session starts, and the writer for the settings file.
  disabledTools: string[];
  saveDisabledTools: SaveDisabledTools;
  // Text sent ahead of the first message of the session (the AGENTS.md file), if any.
  instructions?: string;
}

// The lines that are commands, other than /exit (which ends the loop) and messages.
type CommandLine = Exclude<Line, ExitLine | MessageLine>;

// Runs one command line and writes what it prints. Returns the step to apply when the command
// changes the conversation (compaction), otherwise undefined.
async function runCommand(
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
  return useProfile(conversation, { name: command.value.name, text: loaded.value });
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

// The input lines, in order, held until they are read. `more` says whether another line
// can still arrive: false only once the input has ended and every line has been taken.
class InputLines {
  private queue: string[] = [];
  private ended = false;
  private waiting: ((line: string | undefined) => void) | undefined;

  push(line: string): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(line);
    } else {
      this.queue.push(line);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(undefined);
    }
  }

  // Drops lines typed before this point, so an answer must come after the question.
  discard(): void {
    this.queue = [];
  }

  get more(): boolean {
    return this.queue.length > 0 || !this.ended;
  }

  // Resolves with the next line, or undefined once the input has ended.
  next(): Promise<string | undefined> {
    const line = this.queue.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.ended) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}

// What one request to the model produced: its text, the calls it asked for, and its usage.
interface Round {
  answer: string;
  calls: ToolCall[];
  usage?: Usage;
  failure?: Error;
}

async function streamRound(history: ChatMessage[], reply: Reply, output: Writable, offered: string[]): Promise<Round> {
  const round: Round = { answer: "", calls: [] };
  try {
    for await (const chunk of reply(
      history,
      (usage) => {
        round.usage = usage;
      },
      (call) => {
        round.calls.push(call);
      },
      offered,
    )) {
      if (!chunk.ok) return { ...round, failure: chunk.error };
      round.answer += chunk.value;
      output.write(chunk.value);
    }
  } catch (error) {
    return { ...round, failure: error instanceof Error ? error : new Error(String(error)) };
  }
  return round;
}

// Runs the session until /exit or end of input. A failure of the input or output
// stream ends it early, and that failure is the result. Whatever happens, the
// interface is closed and the listeners are removed before this returns.
export async function runRepl(input: Readable, output: Writable, ports: ReplPorts): Promise<Result<void>> {
  const { reply, contextWindow, tools, instructions } = ports;
  let conversation: Conversation = { history: [], compacted: false, disabledTools: ports.disabledTools };
  let streamError: Error | undefined;
  // Set when /exit is typed at an approval: the session ends and no further request is sent.
  let exitRequested = false;
  const lines = new InputLines();
  // Aborting closes the readline interface, which ends the loop below.
  const controller = new AbortController();
  const fail = (error: Error) => {
    streamError ??= error;
    controller.abort();
  };
  input.on("error", fail);
  output.on("error", fail);
  const rl = createInterface({ input, output, prompt: "> ", signal: controller.signal });
  // Readline re-emits input errors on the interface, and throws if nothing listens.
  rl.on("error", fail);
  rl.on("line", (line) => lines.push(line));
  rl.once("close", () => lines.end());
  // Once the session has ended for good, nothing else runs: no tool, no request, no approval.
  // Queued lines do not count, because a stream failure or /exit ends the session even with
  // lines waiting, and input that has ended with nothing queued cannot answer anything.
  const finished = () => exitRequested || streamError !== undefined || !lines.more;
  // A change is written only when the user answers y. The answer must come after the preview,
  // so lines typed before it are dropped. Ending input, /exit, or any other answer refuses it;
  // /exit also ends the session.
  const approve: Approve = async (preview) => {
    if (exitRequested || streamError !== undefined) return false;
    lines.discard();
    output.write(`${sanitize(preview)}\napply? (y/n) `);
    const line = await lines.next();
    if (line === undefined) return false;
    if (line.trim() === "/exit") {
      exitRequested = true;
      return false;
    }
    return /^y(es)?$/i.test(line.trim());
  };
  const apply = (step: Step) => {
    conversation = step.conversation;
    if (step.notice) output.write(`${step.notice}\n`);
  };
  try {
    rl.prompt();
    for (let line = await lines.next(); line !== undefined && !exitRequested && streamError === undefined; line = await lines.next()) {
      const input = classifyLine(line);
      if (input.kind === "exit") break;
      if (input.kind !== "message") {
        const step = await runCommand(input, ports, output, conversation);
        if (step) apply(step);
        rl.prompt();
        continue;
      }
      apply(await compactIfNeeded(conversation, reply, contextWindow));
      const turnStart = conversation.history.length;
      // The instructions go in front of the first user message, so roles still alternate
      // and compaction drops them with the rest of the old history. A pending profile goes in
      // front of the message after its switch, and is kept until a turn succeeds.
      const first = conversation.history.length === 0 ? instructions : undefined;
      const profile = conversation.pendingProfile;
      const parts = [first, profile, input.text].filter((part): part is string => part !== undefined);
      conversation.history.push({ role: "user", content: parts.join("\n\n") });
      conversation = { ...conversation, pendingProfile: undefined };
      // Each round asks the model. The first round answers the line just received; a round that
      // asked for tools is followed by another only while the session has not ended.
      for (;;) {
        const round = await streamRound(conversation.history, reply, output, enabledTools(conversation));
        if (round.failure) {
          conversation.history.splice(turnStart);
          conversation = { ...conversation, pendingProfile: profile };
          output.write(`\nerror: ${round.failure.message}\n`);
          break;
        }
        conversation.history.push({
          role: "assistant",
          content: round.answer,
          toolCalls: round.calls.length > 0 ? round.calls : undefined,
        });
        // Only a completed request reports its size; a failed one leaves the stored size alone.
        if (round.usage) conversation = recordUsage(conversation, round.usage);
        if (round.calls.length === 0) {
          output.write("\n");
          break;
        }
        for (const call of round.calls) {
          if (finished()) break;
          output.write(`\n${sanitize(describeToolCall(call))}\n`);
          // A tool switched off is not offered, so a call to it is refused without asking for approval.
          const off = conversation.disabledTools?.includes(call.name) ?? false;
          const content = off ? `error: tool ${call.name} is switched off` : await tools(call, approve);
          conversation.history.push({ role: "tool", toolCallId: call.id, content });
        }
        if (finished()) break;
      }
      if (exitRequested || streamError !== undefined) break;
      rl.prompt();
    }
  } finally {
    input.off("error", fail);
    output.off("error", fail);
    rl.close();
  }
  return streamError ? err(streamError) : ok(undefined);
}
