export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

// Token counts the provider reports for one request, taken from the stream.
export interface Usage {
  promptTokens: number;
}
