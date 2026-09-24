import { BASE_URL, authHeaders } from "./config";
import { executeToolCall, tools } from "./tools";
import type { ListModelsResult, RequestMessage, ToolCall } from "./types";

export async function listModels(): Promise<ListModelsResult> {
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

export async function send(
  messages: RequestMessage[],
  model: string,
): Promise<RequestMessage[]> {
  let pending = messages;
  const newMessages: RequestMessage[] = [];
  for (let i = 0; i < 20; i++) {
    let res;
    try {
      res = await fetch(`${BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ model, messages: pending, tools }),
      });
    } catch (err) {
      throw { kind: "network" as const, cause: err };
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const snippet = body.slice(0, 200).trim();
      throw {
        kind: "http" as const,
        status: res.status,
        statusText: res.statusText,
        body: snippet || undefined,
      };
    }
    const data = (await res.json()) as {
      choices?: {
        message?: {
          content?: string;
          tool_calls?: ToolCall[];
        };
      }[];
    };
    const message = data.choices?.[0]?.message ?? {};
    if (message.tool_calls && message.tool_calls.length > 0) {
      const toolCallsMsg: RequestMessage = {
        role: "assistant",
        content: message.content ?? "",
        tool_calls: message.tool_calls,
      };
      newMessages.push(toolCallsMsg);
      const toolResults = await Promise.all(
        message.tool_calls.map(async (call) => {
          const result = await executeToolCall(call);
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: result.content,
          };
        }),
      );
      newMessages.push(...toolResults);
      pending = [...pending, toolCallsMsg, ...toolResults];
      continue;
    }
    const finalMsg: RequestMessage = {
      role: "assistant",
      content: message.content ?? "",
    };
    newMessages.push(finalMsg);
    pending = [...pending, finalMsg];
    return newMessages;
  }
  throw new Error("Exceeded maximum tool call iterations.");
}
