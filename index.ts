import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { streamChat, type ChatMessage } from "./src/openrouter.ts";

const EXIT_WORDS = new Set(["exit", "quit"]);
const MODEL = "anthropic/claude-haiku-5.5";

export type Reply = (messages: ChatMessage[]) => AsyncIterable<string>;

export async function* echoReply(messages: ChatMessage[]): AsyncGenerator<string> {
  yield `echo: ${messages.at(-1)?.content ?? ""}`;
}

export async function runRepl(
  input: Readable,
  output: Writable,
  reply: Reply = echoReply,
): Promise<void> {
  const rl = createInterface({ input, output, prompt: "> " });
  const history: ChatMessage[] = [];
  rl.prompt();
  for await (const line of rl) {
    if (EXIT_WORDS.has(line.trim())) break;
    history.push({ role: "user", content: line });
    try {
      let answer = "";
      for await (const chunk of reply(history)) {
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

if (import.meta.main) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("Set OPENROUTER_API_KEY in .env");
    process.exit(1);
  }
  await runRepl(process.stdin, process.stdout, (messages) =>
    streamChat({ apiKey, model: MODEL, messages }),
  );
}
