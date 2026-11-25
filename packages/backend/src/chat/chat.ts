import type { ChatMessage, ChatStreamEvent } from "common";
import type { UpstreamMessage } from "../openrouter";
import { readRound, streamFrom } from "../openrouter";

/**
 * Puts the backend's own instructions in front of the conversation. The client never
 * sends these, so it cannot change the model's instructions.
 *
 * @param messages The conversation, without system instructions.
 * @param directory The project root to name in the note.
 * @returns The conversation with the system note first.
 */
export function withSystemContext(
  messages: ChatMessage[],
  directory: string,
): UpstreamMessage[] {
  return [
    { role: "system", content: `The working directory is ${directory}.` },
    ...messages,
  ];
}

/**
 * Turns one OpenRouter body into typed events, with no tool calls. Every stream ends
 * with exactly one "done" or "error" event.
 *
 * @param body The raw body of the upstream stream.
 * @returns The events of one round, as they happen.
 */
export function chatEvents(
  body: ReadableStream<Uint8Array>,
): ReadableStream<ChatStreamEvent> {
  return streamFrom(textOnly(body));
}

async function* textOnly(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<ChatStreamEvent, void> {
  const calls = yield* readRound(body);
  if (calls !== undefined) {
    yield {
      type: "error",
      message: "The model asked for a tool, which this stream does not handle",
    };
  }
}
