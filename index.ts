import { createInterface } from "node:readline";
import { LlmClient } from "./src/client/llm.ts";
import type { Message } from "./src/core/errors.ts";

const client = new LlmClient();

const messages: Message[] = [
  { role: "system", content: `Working directory: ${process.cwd()}` },
];

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (line.trim() === "") return;
  if (line.trim() === "/exit") {
    rl.close();
    return;
  }
  messages.push({ role: "user", content: line });
  const result = await client.chat(messages);
  if (result.ok) {
    messages.push({ role: "assistant", content: result.value });
    console.log(result.value);
  } else {
    const err = result.error;
    if (err.kind === "http") {
      console.error(`vise: HTTP ${err.status} from server: ${err.body}`);
    } else if (err.kind === "network") {
      console.error(`vise: ${err.cause}`);
    } else {
      console.error(`vise: malformed response: ${err.body}`);
    }
  }
});
