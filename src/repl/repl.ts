import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ChatMessage, Usage } from "../core/messages.ts";

const EXIT_COMMAND = "/exit";
const CONTEXT_COMMAND = "/context";

export type Reply = (
  messages: ChatMessage[],
  onUsage: (usage: Usage) => void,
) => AsyncIterable<string>;
export type ContextWindow = () => Promise<number | undefined>;

export async function* echoReply(messages: ChatMessage[]): AsyncGenerator<string> {
  yield `echo: ${messages.at(-1)?.content ?? ""}`;
}

function contextLine(used: number | undefined, total: number | undefined): string {
  if (used === undefined) return "context: no request sent yet";
  return `context: ${used} / ${total ?? "unknown"} tokens`;
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
    try {
      const total = promptTokens === undefined ? undefined : await contextWindow();
      output.write(`${contextLine(promptTokens, total)}\n`);
    } catch (error) {
      output.write(`error: ${(error as Error).message}\n`);
    }
  };
  rl.prompt();
  for await (const line of rl) {
    if (line.trim() === EXIT_COMMAND) break;
    if (line.trim() === CONTEXT_COMMAND) {
      await showContext();
      rl.prompt();
      continue;
    }
    history.push({ role: "user", content: line });
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
