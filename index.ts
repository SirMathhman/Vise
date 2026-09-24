import { createInterface } from "node:readline";

const BASE_URL = "http://localhost:8080";

async function getModelName(): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/models`);
  if (!res.ok) return "local";
  const data = (await res.json()) as { data?: { id?: string }[] };
  return data.data?.[0]?.id ?? "local";
}

async function send(message: string, model: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: message }],
    }),
  });
  if (!res.ok) {
    throw new Error(`llama.cpp returned ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return data.choices?.[0]?.message?.content ?? "";
}

async function main(): Promise<void> {
  const model = await getModelName();
  console.log(`Model: ${model}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (): void => {
    rl.question("> ", async (line?: string) => {
      const text = (line ?? "").trim();
      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        rl.close();
        return;
      }
      if (!text) {
        ask();
        return;
      }
      try {
        const reply = await send(text, model);
        console.log(reply);
      } catch (err) {
        console.error(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      ask();
    });
  };

  ask();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});