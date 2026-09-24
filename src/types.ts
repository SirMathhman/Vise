export type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type RequestMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content?: string;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolResponse = { content: string };

export type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

export type ReplState = {
  history: RequestMessage[];
  model: string;
};

export type ReplDeps = {
  send: (
    history: RequestMessage[],
    model: string,
  ) => Promise<RequestMessage[]>;
  listModels: () => Promise<ListModelsResult>;
};
