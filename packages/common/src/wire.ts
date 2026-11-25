import { z } from "zod";
import type { ParseError } from "./parse";
import type { Result } from "./result";
import { parseValue } from "./parse";

// Every JSON shape exchanged between the frontend and the backend. The schemas are the
// source of truth; the TypeScript types are inferred from them.

export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  time: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ModelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number(),
  /** USD per 1 million prompt tokens, or null when the price varies per request. */
  promptPricePerMillion: z.number().nullable(),
  /** USD per 1 million completion tokens, or null when the price varies per request. */
  completionPricePerMillion: z.number().nullable(),
});
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

export const ModelsResponseSchema = z.object({
  models: z.array(ModelSummarySchema),
});
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

export const ErrorResponseSchema = z.object({ error: z.string() });
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const OpenRouterSettingsSchema = z.object({
  /** True when a key is saved in the UI or set in the environment. The key itself is never returned. */
  configured: z.boolean(),
});
export type OpenRouterSettings = z.infer<typeof OpenRouterSettingsSchema>;

export const SaveOpenRouterKeyRequestSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1)
    .refine((key) => !/\s/.test(key), "The API key must not contain spaces"),
});
export type SaveOpenRouterKeyRequest = z.infer<
  typeof SaveOpenRouterKeyRequestSchema
>;

// A turn of the conversation: a message from the user or from the assistant. Clients send
// only turns. Instructions for the model are added by the backend, never by the client.
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z
    .string()
    .refine((text) => text.trim() !== "", "Each message must have text"),
});
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatMessageListSchema = z.array(ChatMessageSchema);

export const ChatRequestSchema = z.object({
  model: z.string().trim().min(1),
  /** The whole conversation so far, ending with the user's new message. */
  messages: ChatMessageListSchema.min(1).refine(
    (messages) => messages[messages.length - 1]?.role === "user",
    "The last message must be from the user",
  ),
});
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

// One event in the chat reply stream. A reply ends with exactly one "done" or "error" event.
export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
  // The model proposed a change that needs the user's approval. The reply waits until the
  // user answers at POST /api/approvals/:id.
  z.object({
    type: z.literal("approval"),
    id: z.string(),
    title: z.string(),
    body: z.string(),
  }),
]);
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

export const ApprovalDecisionSchema = z.object({ approved: z.boolean() });
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

export const ApprovalAckSchema = z.object({ ok: z.literal(true) });

// Checks one untrusted value against the ChatStreamEvent contract.
export function parseChatStreamEvent(
  value: unknown,
): Result<ChatStreamEvent, ParseError> {
  return parseValue(ChatStreamEventSchema, value);
}

// Checks an untrusted list of conversation turns.
export function parseChatMessageList(
  value: unknown,
): Result<ChatMessage[], ParseError> {
  return parseValue(ChatMessageListSchema, value);
}
