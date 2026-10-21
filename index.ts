import { createInterface } from "node:readline";

const STRATA_URL = "http://127.0.0.1:8080/v1/chat/completions";
const MODEL = "qwen3.8-flash-next-iq2_xs";

async function send(content: string): Promise<string> {
  const res = await fetch(STRATA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Strata responded ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices: { message: { content: string } }[];
  };
  return data.choices[0]?.message.content ?? "";
}

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
    try {
      console.log(await send(trimmed));
    } catch (err) {
      console.error(err instanceof Error ? err.message : err);
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
