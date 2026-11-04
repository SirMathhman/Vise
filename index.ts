import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

const EXIT_WORDS = new Set(["exit", "quit"]);

export function runRepl(input: Readable, output: Writable): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({ input, output, prompt: "> " });
    let closed = false;
    rl.on("line", (line) => {
      if (closed) return;
      if (EXIT_WORDS.has(line.trim())) {
        closed = true;
        rl.close();
        return;
      }
      output.write(`echo: ${line}\n`);
      rl.prompt();
    });
    rl.on("close", () => resolve());
    rl.prompt();
  });
}

if (import.meta.main) {
  await runRepl(process.stdin, process.stdout);
}
