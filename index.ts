import { createInterface } from "node:readline";
import { BASE_URL, authHeaders, loadEnv } from "./src/config";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

async function getModelName(): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/models`, { headers: authHeaders() });
  if (!res.ok) return "local";
  const data = (await res.json()) as { data?: { id?: string }[] };
  return data.data?.[0]?.id ?? "local";
}

async function send(history: ChatMessage[], model: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: history,
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
  loadEnv();
  const model = await getModelName();
  console.log(`Model: ${model}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatMessage[] = [];

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
      history.push({ role: "user", content: text });
      try {
        const reply = await send(history, model);
        history.push({ role: "assistant", content: reply });
        console.log(reply);
      } catch (err) {
        history.pop();
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
