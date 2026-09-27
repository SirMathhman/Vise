import { createInterface } from "node:readline";
import { readdirSync } from "node:fs";
import { LlmClient } from "./src/client/llm.ts";
import type { Tool } from "./src/client/llm.ts";
import type { Message, AssistantMessage } from "./src/core/errors.ts";

const client = new LlmClient();

const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "list_directory",
      description: "List the files and directories in a given path",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list (default '.')",
          },
        },
        required: ["path"],
      },
    },
  },
];

function listDirectory(path: string): string {
  try {
    const entries = readdirSync(path);
    return entries.join("\n");
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

async function runTurn(messages: Message[]): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const result = await client.chat(messages, tools);
    if (!result.ok) {
      const err = result.error;
      if (err.kind === "http") {
        console.error(`vise: HTTP ${err.status} from server: ${err.body}`);
      } else if (err.kind === "network") {
        console.error(`vise: ${err.cause}`);
      } else {
        console.error(`vise: malformed response: ${err.body}`);
      }
      return;
    }
    const reply: AssistantMessage = result.value;
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.tool_calls,
      });
      for (const tc of reply.tool_calls) {
        let output: string;
        try {
          const args = JSON.parse(tc.function.arguments);
          output = listDirectory(args.path ?? ".");
        } catch {
          output = `error: failed to execute ${tc.function.name}`;
        }
        messages.push({
          role: "tool",
          content: output,
          tool_call_id: tc.id,
        });
      }
    } else {
      messages.push({ role: "assistant", content: reply.content });
      console.log(reply.content);
      return;
    }
  }
}

const messages: Message[] = [
  { role: "system", content: `Working directory: ${process.cwd()}` },
];

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false,
});

rl.on("line", async (line) => {
  if (line.trim() === "") return;
  if (line.trim() === "/exit") {
    rl.close();
    return;
  }
  messages.push({ role: "user", content: line });
  await runTurn(messages);
});
