import type { AssistantMessage, Message, Result } from "./errors.ts";

/**
 * Definition of a single tool function, as presented to the model. The core
 * owns this type; the edge provides the `Tool[]` definitions and the
 * `ToolRunner` implementation.
 */
export interface Tool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

/**
 * The core depends only on this type, not on a concrete transport, so it can
 * be tested with a stub. The edge provides the implementation (currently
 * `LlmClient` in `client/llm.ts`).
 */
export interface Client {
  chat(messages: Message[], tools?: Tool[]): Promise<Result<AssistantMessage>>;
}

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
 * The text appended to the conversation to request a summary of it. Kept
 * as a constant so the compaction prompt is stable and greppable.
 */
export const SUMMARIZE_PROMPT = "Summarize this conversation";

/**
 * A partition of the conversation for compaction. `toSummarize` is the older
 * portion that will be replaced by a summary; `recent` is the tail of
 * complete turns that is preserved verbatim.
 */
export interface CompactionSplit {
  toSummarize: Message[];
  recent: Message[];
}

/**
 * Split the conversation into the portion to summarize and the most recent
 * `recentTurns` complete turns to keep. A "turn" starts at a user message and
 * runs through the assistant/tool messages that follow it up to the next user
 * message, so the kept tail is always a self-contained, API-valid sequence
 * (no dangling tool_call/tool references). The leading system message is
 * always preserved by the caller and is not part of either half here; pass in
 * the conversation with the system message already removed.
 *
 * Pure: no I/O, depends only on the `Message` type. If there are no user
 * turns at all, everything goes to `toSummarize` and `recent` is empty.
 */
export function splitForCompaction(
  messages: Message[],
  recentTurns: number,
): CompactionSplit {
  // Find the indexes of every user message; these are turn boundaries.
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && m.role === "user") boundaries.push(i);
  }
  if (boundaries.length === 0) {
    return { toSummarize: messages.slice(), recent: [] };
  }
  const keepFromIndex =
    boundaries.length <= recentTurns
      ? boundaries[0]
      : boundaries[boundaries.length - recentTurns];
  return {
    toSummarize: messages.slice(0, keepFromIndex),
    recent: messages.slice(keepFromIndex),
  };
}

/**
 * Produce a summary of the conversation's older portion. Sends the older
 * messages plus the `SUMMARIZE_PROMPT` to the model and returns the model's
 * summary text. Pure: no I/O beyond the `Client` and no `node:` imports.
 */
export async function summarize(
  client: Client,
  toSummarize: Message[],
): Promise<Result<string>> {
  const result = await client.chat([
    ...toSummarize,
    { role: "user", content: SUMMARIZE_PROMPT },
  ]);
  if (!result.ok) return result;
  return { ok: true, value: result.value.content };
}

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
