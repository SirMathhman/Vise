export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type StrataError =
  | { kind: "network"; url: string; cause: string }
  | { kind: "http"; url: string; status: number; body: string }
  | { kind: "malformed"; url: string; reason: string };

export interface StrataConfig {
  url: string;
  model: string;
  fetch: typeof fetch;
}

export const DEFAULT_CONFIG: StrataConfig = {
  url: "http://127.0.0.1:8080/v1/chat/completions",
  model: "qwen3.8-flash-next-iq2_xs",
  fetch,
};

export async function sendMessage(
  content: string,
  config: StrataConfig = DEFAULT_CONFIG,
): Promise<Result<string, StrataError>> {
  const { url, model } = config;

  let res: Response;
  try {
    res = await config.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content }],
      }),
    });
  } catch (err) {
    const cause = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { kind: "network", url, cause } };
  }

  if (!res.ok) {
    const body = await res.text();
    return { ok: false, error: { kind: "http", url, status: res.status, body } };
  }

  const data: unknown = await res.json();
  const reply = extractReply(data);
  if (reply === undefined) {
    return {
      ok: false,
      error: { kind: "malformed", url, reason: "no choices[0].message.content string" },
    };
  }
  return { ok: true, value: reply };
}

function extractReply(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("choices" in data)) {
    return undefined;
  }
  const choices = data.choices;
  if (!Array.isArray(choices)) return undefined;
  const message: unknown = choices[0]?.message;
  if (typeof message !== "object" || message === null || !("content" in message)) {
    return undefined;
  }
  return typeof message.content === "string" ? message.content : undefined;
}

export function describeStrataError(error: StrataError): string {
  switch (error.kind) {
    case "network":
      return `Strata not reachable at ${error.url} (${error.cause}). Start the Strata server and try again.`;
    case "http":
      return `Strata at ${error.url} returned HTTP ${error.status}: ${error.body}`;
    case "malformed":
      return `Strata at ${error.url} returned an unexpected response (${error.reason}).`;
  }
}
