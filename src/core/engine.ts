import type { Client, Tool } from "../client/llm.ts";
import type { Message, Result } from "./errors.ts";

/**
 * Executes a tool invocation with the given name and arguments, returning a
 * string result (or an error string). The edge provides the implementation;
 * the core depends only on this interface so it can be tested with a stub.
 */
export interface ToolRunner {
  run(name: string, args: Record<string, unknown>): string;
}

const MAX_TOOL_ROUNDS = 10;

/**
 * Pure core pipeline: takes the accumulated conversation and a user line,
 * runs the model, dispatches any tool calls through `tools`, and returns the
 * assistant's final content. Mutates `messages` (appending assistant and
 * tool messages). No `node:` imports, no I/O — depends only on `Client` and
 * `ToolRunner`, so it is testable with stubs.
 */
export async function runTurn(
  client: Client,
  tools: ToolRunner,
  messages: Message[],
  toolDefs: Tool[],
): Promise<Result<string>> {
  for (let i = 0; i < MAX_TOOL_ROUNDS; i++) {
    const result = await client.chat(messages, toolDefs);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }
    const reply = result.value;
    if (reply.tool_calls && reply.tool_calls.length > 0) {
      messages.push({
        role: "assistant",
        content: reply.content,
        tool_calls: reply.tool_calls,
      });
      for (const tc of reply.tool_calls) {
        let output: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<
            string,
            unknown
          >;
          output = tools.run(tc.function.name, args);
        } catch {
          output = `error: failed to execute ${tc.function.name}`;
        }
        messages.push({ role: "tool", content: output, tool_call_id: tc.id });
      }
    } else {
      messages.push({ role: "assistant", content: reply.content });
      return { ok: true, value: reply.content };
    }
  }
  return {
    ok: false,
    error: { kind: "malformed", body: "exceeded maximum tool rounds" },
  };
}
