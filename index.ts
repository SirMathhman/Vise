import { createInterface } from "node:readline";
import { LlmClient } from "./src/client/llm.ts";
import { tools, toolRunner } from "./src/tools.ts";
import { Session } from "./src/repl/session.ts";
import { formatCompactionFailure, formatError } from "./src/output/format.ts";

const client = new LlmClient();
const session = new Session(
  client,
  toolRunner,
  tools,
  client,
  process.cwd(),
  client,
);

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

let chain = Promise.resolve();
rl.on("line", (line) => {
  if (line.trim() === "") return;
  chain = chain.then(async () => {
    const result = await session.handleLine(line);
    if (result === "exit") {
      rl.close();
      return;
    }
    if (result.ok) {
      console.log(result.value);
      if (result.compactionWarning) {
        console.error(formatCompactionFailure(result.compactionWarning));
      }
    } else {
      console.error(formatError(result.error));
    }
  });
});
