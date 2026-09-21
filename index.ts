import * as readline from "node:readline";

// Endpoint of the already-running OpenAI-compatible LLM server (llama.cpp).
const BASE_URL = process.env.LLM_BASE_URL ?? "http://localhost:8080";
const MODEL = process.env.LLM_MODEL ?? "local";
// Sent as a Bearer token only when set (the server may run without a key).
const API_KEY = process.env.LLM_API_KEY;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});
// Piped stdin ending sets this flag; the loop finishes the in-flight request
// before exiting so the result is always printed.
let stdinEnded = false;
process.stdin.on("end", () => {
  stdinEnded = true;
});
// Ctrl-C exits immediately (there is nothing to drain).
process.on("SIGINT", () => {
  console.log("\nBye.");
  process.exit(0);
});

// Wrap rl.question (callback-based) in a Promise.
const ask = () =>
  new Promise<string>((resolve) => rl.question("you> ", resolve));

for (;;) {
  if (stdinEnded) break;
  const text = (await ask()).trim();
  if (text.length === 0) continue;

  try {
    // Exactly one message per request.
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: text }],
      }),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`HTTP ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const answer = data.choices?.[0]?.message?.content;
    console.log(`\nassistant> ${answer ?? "(empty response)"}\n`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// Loop broke on EOF (or stdin was drained); nothing left to do.
process.exit(0);
