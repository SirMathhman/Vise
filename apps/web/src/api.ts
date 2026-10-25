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

export interface ToolInfo {
  name: string;
  description: string;
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

export async function fetchTools(): Promise<ToolInfo[]> {
  const res = await fetch("/api/tools");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<ToolInfo[]>;
}
