import type { Message, Result } from "../core/errors.ts";

export interface Client {
  chat(messages: Message[]): Promise<Result<string>>;
}

const URL = "http://localhost:8080/v1/chat/completions";
const API_KEY = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";
const MODEL =
  "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA";

export class LlmClient implements Client {
  async chat(messages: Message[]): Promise<Result<string>> {
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          stream: false,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: { kind: "http", status: res.status, body } };
      }
      const data = (await res.json()) as {
        choices: { message: { content: string } }[];
      };
      const content = data.choices[0]?.message.content;
      if (content === undefined) {
        return { ok: false, error: { kind: "malformed", body: JSON.stringify(data) } };
      }
      return { ok: true, value: content };
    } catch (err) {
      return {
        ok: false,
        error: { kind: "network", cause: err instanceof Error ? err.message : String(err) },
      };
    }
  }
}
