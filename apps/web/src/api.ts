export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface ToolUse {
  name: string;
  arguments: Record<string, unknown>;
  result: string;
}

export interface ChatResponse {
  content?: string;
  tool_calls?: ToolUse[];
}

export async function sendChat(messages: Message[]): Promise<ChatResponse> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ChatResponse>;
}
