// Stdin buffering. No fetch, no state beyond the line queue.
import * as readline from "node:readline";

export type Input = {
  nextLine: () => Promise<string>;
  close: () => void;
};

export function createInput(): Input {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // Every "line" event is pushed onto a buffer as it arrives, so piped lines
  // that land while a fetch is in flight are not lost.
  const lines: string[] = [];
  let closed = false;
  rl.on("line", (line) => {
    lines.push(line);
  });
  rl.on("close", () => {
    closed = true;
  });
  process.on("SIGINT", () => {
    console.log("\nBye.");
    close();
  });

  // Resolves with the next buffered line, or "" once input has closed and no
  // lines remain.
  const nextLine = (): Promise<string> => {
    if (lines.length > 0) return Promise.resolve(lines.shift() ?? "");
    if (closed) return Promise.resolve("");
    return new Promise((resolve) => {
      const done = (value: string) => {
        rl.removeListener("line", onLine);
        rl.removeListener("close", onClose);
        resolve(value);
      };
      const onLine = () => done(lines.shift() ?? "");
      const onClose = () => done("");
      rl.on("line", onLine);
      rl.on("close", onClose);
    });
  };

  const close = (): void => {
    rl.close();
  };

  return { nextLine, close };
}
