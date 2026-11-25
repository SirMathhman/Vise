import type { ChatMessage, ChatStreamEvent } from "common";
import type { UpstreamMessage } from "../openrouter";
import { readRound, streamFrom } from "../openrouter";

/**
 * The text of the backend's system instructions: the working directory, then the profile's
 * instructions when one is chosen. The client never sends these, so it cannot write them.
 *
 * @param directory The project root to name.
 * @param instructions The chosen profile's instructions, if any.
 * @returns The system instructions as one text.
 */
export function systemContextText(
  directory: string,
  instructions?: string,
): string {
  const parts = [`The working directory is ${directory}.`];
  if (instructions !== undefined && instructions.trim() !== "") {
    parts.push(instructions);
  }
  return parts.join("\n\n");
}

/**
 * Puts the backend's own instructions in front of the conversation as one system message.
 *
 * @param messages The conversation, without system instructions.
 * @param directory The project root to name in the note.
 * @param instructions The chosen profile's instructions, if any.
 * @returns The conversation with the system note first.
 */
export function withSystemContext(
  messages: ChatMessage[],
  directory: string,
  instructions?: string,
): UpstreamMessage[] {
  return [
    {
      role: "system",
      content: systemContextText(directory, instructions),
    },
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
