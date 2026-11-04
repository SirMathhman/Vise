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
import { approvalPreview, describeToolCall, needsApproval, type ToolRunner } from "../core/tools.ts";
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

// Writes a question and resolves with the next line of input, or "" if input ends first.
// It reads from the same lines the session reads, so a line typed while the model was
// answering is taken as the answer.
async function askLine(lines: AsyncIterator<string>, output: Writable, question: string): Promise<string> {
  output.write(question);
  const next = await lines.next();
  return next.done ? "" : next.value;
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
): Promise<Result<void>> {
  let conversation: Conversation = { history: [], compacted: false };
  let streamError: Error | undefined;
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
  const apply = (step: Step) => {
    conversation = step.conversation;
    if (step.notice) output.write(`${step.notice}\n`);
  };
  try {
    const lines = rl[Symbol.asyncIterator]();
    rl.prompt();
    for (let next = await lines.next(); !next.done; next = await lines.next()) {
      const input = classifyLine(next.value);
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
      if (input.kind === "unknown-command") {
        output.write(`error: unknown command ${input.command}\n`);
        rl.prompt();
        continue;
      }
      apply(await compactIfNeeded(conversation, reply, contextWindow));
      const turnStart = conversation.history.length;
      conversation.history.push({ role: "user", content: input.text });
      // Each round asks the model; a round that asked for tools is followed by another.
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
          output.write(`\n${describeToolCall(call)}\n`);
          // An edit is written only when the user answers y.
          const preview = needsApproval(call) ? approvalPreview(call) : undefined;
          if (preview !== undefined) {
            const answer = await askLine(lines, output, `${preview}\napply? (y/n) `);
            if (!/^y(es)?$/i.test(answer.trim())) {
              conversation.history.push({ role: "tool", toolCallId: call.id, content: "the user declined this change" });
              continue;
            }
          }
          conversation.history.push({ role: "tool", toolCallId: call.id, content: await tools(call) });
        }
      }
      rl.prompt();
    }
  } finally {
    input.off("error", fail);
    output.off("error", fail);
    rl.close();
  }
  return streamError ? err(streamError) : ok(undefined);
}
