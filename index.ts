import { createInterface } from "node:readline";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", (line) => {
  console.log(line);
});
