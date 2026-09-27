import { createInterface } from "node:readline";

const URL = "http://localhost:8080/v1/chat/completions";
const API_KEY = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";
const MODEL =
  "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA";

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (line.trim() === "") return;
  if (line.trim() === "/exit") {
    rl.close();
    return;
  }
  try {
    const res = await fetch(URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: line }],
        stream: false,
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error(`vise: HTTP ${res.status} from server: ${body}`);
      return;
    }
    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
    };
    console.log(data.choices[0]?.message.content ?? "");
  } catch (err) {
    console.error(`vise: ${err instanceof Error ? err.message : String(err)}`);
  }
});
