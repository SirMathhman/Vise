import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine, contextLine } from "../core/commands.ts";
import { compact, needsCompaction, type Conversation } from "../core/compaction.ts";
import type { ChatMessage, ContextWindow, Reply, Usage } from "../core/messages.ts";
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

// Runs the session until /exit or end of input. A failure of the input or output
// stream ends it early, and that failure is the result. Whatever happens, the
// interface is closed and the listeners are removed before this returns.
export async function runRepl(
  input: Readable,
  output: Writable,
  reply: Reply = echoReply,
  contextWindow: ContextWindow = async () => err(new Error("no context window is configured")),
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
  const runCompact = async () => {
    const result = await compact(conversation, reply);
    if (result.ok) {
      conversation = result.value;
      output.write("history compacted\n");
    } else {
      output.write(`error: compaction failed: ${result.error.message}\n`);
    }
  };
  const compactIfFull = async () => {
    if (conversation.promptTokens === undefined) return;
    const result = await contextWindow();
    if (!result.ok) {
      output.write(`error: could not check the context window: ${result.error.message}\n`);
      return;
    }
    if (needsCompaction(conversation.promptTokens, result.value)) await runCompact();
  };
  try {
    rl.prompt();
    for await (const line of rl) {
      const input = classifyLine(line);
      if (input.kind === "exit") break;
      if (input.kind === "context") {
        await showContext(output, contextWindow, conversation);
        rl.prompt();
        continue;
      }
      if (input.kind === "compact") {
        await runCompact();
        rl.prompt();
        continue;
      }
      if (input.kind === "unknown-command") {
        output.write(`error: unknown command ${input.command}\n`);
        rl.prompt();
        continue;
      }
      await compactIfFull();
      conversation.history.push({ role: "user", content: input.text });
      let answer = "";
      let failure: Error | undefined;
      let usage: Usage | undefined;
      try {
        for await (const chunk of reply(conversation.history, (reported) => {
          usage = reported;
        })) {
          if (!chunk.ok) {
            failure = chunk.error;
            break;
          }
          answer += chunk.value;
          output.write(chunk.value);
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error(String(error));
      }
      if (failure) {
        conversation.history.pop();
        output.write(`\nerror: ${failure.message}\n`);
      } else {
        conversation.history.push({ role: "assistant", content: answer });
        // Only a completed request reports its size; a failed one leaves the stored size alone.
        if (usage) {
          conversation.promptTokens = usage.promptTokens;
          conversation.compacted = false;
        }
        output.write("\n");
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
