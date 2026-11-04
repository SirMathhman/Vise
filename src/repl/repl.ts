import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine, contextLine } from "../core/commands.ts";
import { compactedHistory, compactionRequest, needsCompaction } from "../core/compaction.ts";
import type { ChatMessage, Usage } from "../core/messages.ts";
import { err, ok, type Result } from "../core/result.ts";

export type Reply = (
  messages: ChatMessage[],
  onUsage: (usage: Usage) => void,
) => AsyncIterable<Result<string>>;
export type ContextWindow = () => Promise<Result<number>>;

export async function* echoReply(messages: ChatMessage[]): AsyncGenerator<Result<string>> {
  yield ok(`echo: ${messages.at(-1)?.content ?? ""}`);
}

// Replaces the history with a summary of it. The summary request's usage is not
// reported, because the history it describes is about to change.
async function compact(history: ChatMessage[], reply: Reply): Promise<Result<void>> {
  if (history.length === 0) return err(new Error("nothing to compact"));
  let summary = "";
  try {
    for await (const chunk of reply(compactionRequest(history), () => {})) {
      if (!chunk.ok) return chunk;
      summary += chunk.value;
    }
  } catch (error) {
    return err(error as Error);
  }
  history.splice(0, history.length, ...compactedHistory(summary, history));
  return ok(undefined);
}

async function showContext(
  output: Writable,
  contextWindow: ContextWindow,
  promptTokens: number | undefined,
): Promise<void> {
  let total: number | undefined;
  if (promptTokens !== undefined) {
    const result = await contextWindow();
    if (result.ok) total = result.value;
    else output.write(`error: /context could not read the model's window: ${result.error.message}\n`);
  }
  output.write(`${contextLine(promptTokens, total)}\n`);
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
  const history: ChatMessage[] = [];
  let promptTokens: number | undefined;
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
  const onUsage = (usage: Usage) => {
    promptTokens = usage.promptTokens;
  };
  const runCompact = async () => {
    const result = await compact(history, reply);
    if (result.ok) {
      // The stored prompt size describes the old history, so it no longer applies.
      promptTokens = undefined;
      output.write("history compacted\n");
    } else {
      output.write(`error: compaction failed: ${result.error.message}\n`);
    }
  };
  const compactIfFull = async () => {
    if (promptTokens === undefined) return;
    const result = await contextWindow();
    if (!result.ok) {
      output.write(`error: could not check the context window: ${result.error.message}\n`);
      return;
    }
    if (needsCompaction(promptTokens, result.value)) await runCompact();
  };
  try {
    rl.prompt();
    for await (const line of rl) {
      const input = classifyLine(line);
      if (input.kind === "exit") break;
      if (input.kind === "context") {
        await showContext(output, contextWindow, promptTokens);
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
      history.push({ role: "user", content: input.text });
      let answer = "";
      let failure: Error | undefined;
      try {
        for await (const chunk of reply(history, onUsage)) {
          if (!chunk.ok) {
            failure = chunk.error;
            break;
          }
          answer += chunk.value;
          output.write(chunk.value);
        }
      } catch (error) {
        failure = error as Error;
      }
      if (failure) {
        history.pop();
        output.write(`\nerror: ${failure.message}\n`);
      } else {
        history.push({ role: "assistant", content: answer });
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
