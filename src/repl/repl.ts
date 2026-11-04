import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine, contextLine } from "../core/commands.ts";
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

// Runs the session until /exit or end of input. A failure of the input or output
// stream ends it early, and that failure is the result.
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
  const showContext = async () => {
    let total: number | undefined;
    if (promptTokens !== undefined) {
      const result = await contextWindow();
      if (result.ok) total = result.value;
      else output.write(`error: /context could not read the model's window: ${result.error.message}\n`);
    }
    output.write(`${contextLine(promptTokens, total)}\n`);
  };
  rl.prompt();
  for await (const line of rl) {
    const input = classifyLine(line);
    if (input.kind === "exit") break;
    if (input.kind === "context") {
      await showContext();
      rl.prompt();
      continue;
    }
    if (input.kind === "unknown-command") {
      output.write(`error: unknown command ${input.command}\n`);
      rl.prompt();
      continue;
    }
    history.push({ role: "user", content: input.text });
    let answer = "";
    let failure: Error | undefined;
    const onUsage = (usage: Usage) => {
      promptTokens = usage.promptTokens;
    };
    for await (const chunk of reply(history, onUsage)) {
      if (!chunk.ok) {
        failure = chunk.error;
        break;
      }
      answer += chunk.value;
      output.write(chunk.value);
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
  return streamError ? err(streamError) : ok(undefined);
}
