export type ChatMessage = { role: "user" | "assistant"; content: string };

// Token counts the provider reports for one request, taken from the stream.
export type Usage = { promptTokens: number };
