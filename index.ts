import { createInterface } from "node:readline";
import { readdir } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { BASE_URL, authHeaders, getApiKey, loadEnv } from "./src/config";

type ToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type RequestMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content?: string;
      tool_calls?: ToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolResponse = { content: string };

const LIST_FILES_TOOL = {
  type: "function",
  function: {
    name: "list_files",
    description: "List the file and directory entries in a directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The directory to list. Defaults to the current working directory.",
        },
      },
      required: [] as string[],
    },
  },
};

type ListModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; error: string };

async function listModels(): Promise<ListModelsResult> {
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

async function executeToolCall(call: ToolCall): Promise<ToolResponse> {
  if (call.function.name === "list_files") {
    const raw: unknown = call.function.arguments;
    const args = (raw && typeof raw === "object" ? raw : {}) as Record<
      string,
      unknown
    >;
    const path =
      typeof args["path"] === "string" && args["path"] !== ""
        ? args["path"]
        : process.cwd();
    try {
      const entries = await readdir(path, { withFileTypes: true });
      const items = entries.map((entry: Dirent) => ({
        name: entry.name,
        type: entry.isDirectory() ? "directory" : "file",
      }));
      return { content: JSON.stringify(items, null, 2) };
    } catch (err) {
      return { content: `Error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
  return { content: `Unknown tool: ${call.function.name}` };
}

async function send(
  history: RequestMessage[],
  model: string,
): Promise<RequestMessage[]> {
  const systemMsg: RequestMessage = {
    role: "system",
    content: `Current working directory: ${process.cwd()}`,
  };
  const messages: RequestMessage[] = [systemMsg, ...history];
  const tools = [LIST_FILES_TOOL];
  let pending = messages;
  for (let i = 0; i < 20; i++) {
    const res = await fetch(`${BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages: pending, tools }),
    });
    if (!res.ok) {
      throw new Error(`llama.cpp returned ${res.status} ${res.statusText}`);
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
      pending = [
        ...pending,
        toolCallsMsg,
        ...(await Promise.all(
          message.tool_calls.map(async (call) => {
            const result = await executeToolCall(call);
            return {
              role: "tool" as const,
              tool_call_id: call.id,
              content: result.content,
            };
          }),
        )),
      ];
      continue;
    }
    const finalMsg: RequestMessage = {
      role: "assistant",
      content: message.content ?? "",
    };
    pending = [...pending, finalMsg];
    return pending.slice(1 + history.length);
  }
  throw new Error("Exceeded maximum tool call iterations.");
}

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}\u2026${key.slice(-4)} (${key.length} chars)`;
}

function printEnvInfo(model: string): void {
  const apiKey = getApiKey();
  console.log(`Server:  ${BASE_URL}`);
  console.log(`Model:   ${model}`);
  console.log(`API key: ${apiKey ? maskKey(apiKey) : "not set"}`);
  console.log(
    `Runtime: ${process.version} (${process.platform}/${process.arch})`,
  );
}

async function main(): Promise<void> {
  loadEnv();
  const discovered = await listModels();
  if (!discovered.ok) {
    console.error(`Cannot reach ${BASE_URL}/v1/models: ${discovered.error}`);
    process.exit(1);
  }
  const initialModel = discovered.models[0];
  if (initialModel === undefined) {
    console.error(`No models reported by ${BASE_URL}/v1/models.`);
    process.exit(1);
  }
  let model = initialModel;
  console.log(`Model: ${model}`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: RequestMessage[] = [];

  const ask = (): void => {
    rl.question("> ", async (line?: string) => {
      const text = (line ?? "").trim();
      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        rl.close();
        return;
      }
      if (!text) {
        ask();
        return;
      }
      if (text.toLowerCase() === "/whoami") {
        printEnvInfo(model);
        ask();
        return;
      }
      if (
        text.toLowerCase() === "/model" ||
        text.toLowerCase().startsWith("/model ")
      ) {
        const name = text.slice("/model".length).trim();
        const result = await listModels();
        if (!result.ok) {
          console.error(`Cannot list models: ${result.error}`);
        } else if (!name) {
          if (result.models.length === 0) {
            console.log("No models reported by the server.");
          } else {
            for (const id of result.models) {
              console.log(`${id === model ? "* " : "  "}${id}`);
            }
          }
        } else if (result.models.includes(name)) {
          model = name;
          console.log(`Model: ${model}`);
        } else {
          console.error(`Unknown model: ${name}`);
        }
        ask();
        return;
      }
      history.push({ role: "user", content: text });
      try {
        const newMessages = await send(history, model);
        for (const m of newMessages) {
          history.push(m);
        }
        const last = newMessages[newMessages.length - 1];
        if (last !== undefined) {
          console.log(last.content ?? "");
        }
      } catch (err) {
        history.pop();
        console.error(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      ask();
    });
  };

  ask();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
