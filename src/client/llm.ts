import type { Message, AssistantMessage, Result } from "../core/errors.ts";
import type { Client, Tool } from "../core/engine.ts";

const URL = "http://localhost:8080/v1/chat/completions";
const API_KEY = "S6677k5w355Nw9ErxCZWYCMiW4ItldmzXBLUElpnLsdE8gBj5A";
const MODEL =
  "RentedNoodle/Qwen3.8-27B-OrcaRouter-GSQ-RCO-IQ3_XXS-Uncensored:QATFA";

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface ChoiceMessage {
  content?: string;
  tool_calls?: ToolCall[];
}

interface Usage {
  prompt_tokens?: number;
}

interface ChatResponse {
  choices: { message: ChoiceMessage }[];
  usage?: Usage;
}

interface Slot {
  n_ctx: number;
}

export class LlmClient implements Client {
  private lastPromptTokens: number | undefined;

  /**
   * The server's token count of the most recent prompt sent via `chat`.
   * `undefined` until the first successful `chat` returns a `usage` block.
   */
  lastPromptTokensUsed(): number | undefined {
    return this.lastPromptTokens;
  }

  /**
   * The model's maximum context window in tokens, as reported live by the
   * server via `GET /slots?model=<id>` (`n_ctx` on each slot).
   */
  async contextMax(): Promise<Result<number>> {
    try {
      const res = await fetch(
        `http://localhost:8080/slots?model=${encodeURIComponent(MODEL)}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${API_KEY}` },
        },
      );
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: { kind: "http", status: res.status, body: text },
        };
      }
      const slots = (await res.json()) as Slot[];
      const first =
        Array.isArray(slots) && slots.length > 0 ? slots[0] : undefined;
      const nCtx = first?.n_ctx;
      if (nCtx === undefined) {
        return {
          ok: false,
          error: {
            kind: "malformed",
            body: "slots response had no n_ctx",
          },
        };
      }
      return { ok: true, value: nCtx };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "network",
          cause: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
  async chat(
    messages: Message[],
    tools?: Tool[],
  ): Promise<Result<AssistantMessage>> {
    const body: Record<string, unknown> = {
      model: MODEL,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }
    try {
      const res = await fetch(URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${API_KEY}`,
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        return {
          ok: false,
          error: { kind: "http", status: res.status, body: text },
        };
      }
      const data = (await res.json()) as ChatResponse;
      const choice = data.choices[0]?.message;
      if (!choice) {
        return {
          ok: false,
          error: { kind: "malformed", body: JSON.stringify(data) },
        };
      }
      this.lastPromptTokens = data.usage?.prompt_tokens;
      return {
        ok: true,
        value: {
          content: choice.content ?? "",
          tool_calls: choice.tool_calls,
        },
      };
    } catch (err) {
      return {
        ok: false,
        error: {
          kind: "network",
          cause: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }
}
