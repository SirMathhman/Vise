import { createInterface } from "node:readline";
import { LlmClient } from "./src/client/llm.ts";
import { tools, toolRunner } from "./src/tools.ts";
import { Session } from "./src/repl/session.ts";
import { formatError } from "./src/output/format.ts";

const client = new LlmClient();
const session = new Session(client, toolRunner, tools, process.cwd());

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (line.trim() === "") return;
  const result = await session.handleLine(line);
  if (result === "exit") {
    rl.close();
    return;
  }
  if (result.ok) {
    console.log(result.value);
  } else {
    console.error(formatError(result.error));
  }
});
