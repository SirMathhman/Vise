import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine, contextLine } from "../core/commands.ts";
import {
  compactIfNeeded,
  compactNow,
  recordUsage,
  type Conversation,
  type Step,
} from "../core/compaction.ts";
import type { ChatMessage, ContextWindow, Reply, ToolCall, Usage } from "../core/messages.ts";
import type { NoteRunner } from "../core/notes.ts";
import { describeToolCall, sanitize, type Approve, type ToolRunner } from "../core/tools.ts";
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

async function streamRound(history: ChatMessage[], reply: Reply, output: Writable): Promise<Round> {
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
export async function runRepl(
  input: Readable,
  output: Writable,
  reply: Reply = echoReply,
  contextWindow: ContextWindow = async () => err(new Error("no context window is configured")),
  tools: ToolRunner = async () => "no tools are available",
  // Text sent ahead of the first message of the session (the AGENTS.md file), if any.
  instructions?: string,
  notes: NoteRunner = async () => "notes are not available",
): Promise<Result<void>> {
  let conversation: Conversation = { history: [], compacted: false };
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
      if (input.kind === "context") {
        await showContext(output, contextWindow, conversation);
        rl.prompt();
        continue;
      }
      if (input.kind === "compact") {
        apply(await compactNow(conversation, reply));
        rl.prompt();
        continue;
      }
      // A line that only prints text: a /note line, or an unknown command.
      if (input.kind === "unknown-command" || input.kind === "note") {
        const text = input.kind === "note" ? await notes(input.words) : `error: unknown command ${input.command}`;
        output.write(`${text}\n`);
        rl.prompt();
        continue;
      }
      apply(await compactIfNeeded(conversation, reply, contextWindow));
      const turnStart = conversation.history.length;
      // The instructions go in front of the first user message, so roles still alternate
      // and compaction drops them with the rest of the old history.
      const first = conversation.history.length === 0 && instructions !== undefined;
      conversation.history.push({ role: "user", content: first ? `${instructions}\n\n${input.text}` : input.text });
      // Each round asks the model. The first round answers the line just received; a round that
      // asked for tools is followed by another only while the session has not ended.
      for (;;) {
        const round = await streamRound(conversation.history, reply, output);
        if (round.failure) {
          conversation.history.splice(turnStart);
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
          conversation.history.push({ role: "tool", toolCallId: call.id, content: await tools(call, approve) });
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
