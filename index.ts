import { createInterface } from "node:readline";
import { DEFAULT_CONFIG, describeStrataError, sendMessage } from "./strata.ts";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: true,
});

console.log("Strata REPL ready. Type 'exit' or press Ctrl+C to quit.");
rl.setPrompt("> ");
rl.prompt();

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed === "exit" || trimmed === "quit") {
    rl.close();
    return;
  }
  if (trimmed !== "") {
    const result = await sendMessage(trimmed, DEFAULT_CONFIG);
    if (result.ok) {
      console.log(result.value);
    } else {
      console.error(describeStrataError(result.error));
    }
  }
  rl.prompt();
});

rl.on("SIGINT", () => {
  console.log();
  rl.close();
});

// Event loop drains when the interface closes (EOF or exit), so the process ends.
rl.on("close", () => console.log("bye"));
