import { createInterface } from "node:readline";
import { BASE_URL, authHeaders, getApiKey, loadEnv } from "./src/config";

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

async function listModels(): Promise<ListModelsResult> {
  try {
    const res = await fetch(`${BASE_URL}/v1/models`, {
      headers: authHeaders(),
    });
    if (!res.ok) {
      return { ok: false, error: `${res.status} ${res.statusText}` };
    }
    const data = (await res.json()) as { data?: { id?: string }[] };
    return {
      ok: true,
      models: (data.data ?? [])
        .map((entry) => entry.id)
        .filter((id): id is string => id !== undefined),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
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

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}\u2026${key.slice(-4)} (${key.length} chars)`;
}

function printEnvInfo(model: string): void {
  const apiKey = getApiKey();
  console.log(`Server:  ${BASE_URL}`);
  console.log(`Model:   ${model}`);
  console.log(`API key: ${apiKey ? maskKey(apiKey) : "not set"}`);
  console.log(
    `Runtime: ${process.version} (${process.platform}/${process.arch})`,
  );
}

async function main(): Promise<void> {
  loadEnv();
  const discovered = await listModels();
  if (!discovered.ok) {
    console.error(`Cannot reach ${BASE_URL}/v1/models: ${discovered.error}`);
    process.exit(1);
  }
  const initialModel = discovered.models[0];
  if (initialModel === undefined) {
    console.error(`No models reported by ${BASE_URL}/v1/models.`);
    process.exit(1);
  }
  let model = initialModel;
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
      if (text.toLowerCase() === "/whoami") {
        printEnvInfo(model);
        ask();
        return;
      }
      if (
        text.toLowerCase() === "/model" ||
        text.toLowerCase().startsWith("/model ")
      ) {
        const name = text.slice("/model".length).trim();
        const result = await listModels();
        if (!result.ok) {
          console.error(`Cannot list models: ${result.error}`);
        } else if (!name) {
          if (result.models.length === 0) {
            console.log("No models reported by the server.");
          } else {
            for (const id of result.models) {
              console.log(`${id === model ? "* " : "  "}${id}`);
            }
          }
        } else if (result.models.includes(name)) {
          model = name;
          console.log(`Model: ${model}`);
        } else {
          console.error(`Unknown model: ${name}`);
        }
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
