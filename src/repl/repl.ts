import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { classifyLine, contextLine } from "../core/commands.ts";
import type { ChatMessage, Usage } from "../core/messages.ts";

export type Reply = (
  messages: ChatMessage[],
  onUsage: (usage: Usage) => void,
) => AsyncIterable<string>;
export type ContextWindow = () => Promise<number | undefined>;

export async function* echoReply(messages: ChatMessage[]): AsyncGenerator<string> {
  yield `echo: ${messages.at(-1)?.content ?? ""}`;
}

export async function runRepl(
  input: Readable,
  output: Writable,
  reply: Reply = echoReply,
  contextWindow: ContextWindow = async () => undefined,
): Promise<void> {
  const rl = createInterface({ input, output, prompt: "> " });
  const history: ChatMessage[] = [];
  let promptTokens: number | undefined;
  const showContext = async () => {
    let total: number | undefined;
    if (promptTokens !== undefined) {
      try {
        total = await contextWindow();
      } catch (error) {
        output.write(`error: /context could not read the model's window: ${(error as Error).message}\n`);
      }
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
    try {
      let answer = "";
      const onUsage = (usage: Usage) => {
        promptTokens = usage.promptTokens;
      };
      for await (const chunk of reply(history, onUsage)) {
        answer += chunk;
        output.write(chunk);
      }
      history.push({ role: "assistant", content: answer });
      output.write("\n");
    } catch (error) {
      history.pop();
      output.write(`\nerror: ${(error as Error).message}\n`);
    }
    rl.prompt();
  }
}
