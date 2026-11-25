import { z } from "zod";
import type { ParseError } from "./parse";
import type { Result } from "./result";
import { parseValue } from "./parse";

// Every JSON shape exchanged between the frontend and the backend. The schemas are the
// source of truth; the TypeScript types are inferred from them.

/**
 * The reply of GET /api/health: the service status and the time it was checked.
 */
export const HealthResponseSchema = z.object({
  status: z.literal("ok"),
  service: z.string(),
  time: z.string(),
});
/**
 * The reply of GET /api/health.
 */
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/**
 * One model in the OpenRouter list, with its context window and prices per million tokens.
 */
export const ModelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number(),
  /** USD per 1 million prompt tokens, or null when the price varies per request. */
  promptPricePerMillion: z.number().nullable(),
  /** USD per 1 million completion tokens, or null when the price varies per request. */
  completionPricePerMillion: z.number().nullable(),
});
/**
 * One model in the OpenRouter list.
 */
export type ModelSummary = z.infer<typeof ModelSummarySchema>;

/**
 * The reply of GET /api/models.
 */
export const ModelsResponseSchema = z.object({
  models: z.array(ModelSummarySchema),
});
/**
 * The reply of GET /api/models.
 */
export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;

/**
 * The body of a failed request: a human-readable error message.
 */
export const ErrorResponseSchema = z.object({ error: z.string() });
/**
 * The body of a failed request.
 */
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * Whether an OpenRouter key is configured. The key itself is never sent back.
 */
export const OpenRouterSettingsSchema = z.object({
  /** True when a key is saved in the UI or set in the environment. The key itself is never returned. */
  configured: z.boolean(),
});
/**
 * Whether an OpenRouter key is configured.
 */
export type OpenRouterSettings = z.infer<typeof OpenRouterSettingsSchema>;

/**
 * The body of PUT /api/settings/openrouter: the key to save.
 */
export const SaveOpenRouterKeyRequestSchema = z.object({
  apiKey: z
    .string()
    .trim()
    .min(1)
    .refine((key) => !/\s/.test(key), "The API key must not contain spaces"),
});
/**
 * The body of PUT /api/settings/openrouter.
 */
export type SaveOpenRouterKeyRequest = z.infer<
  typeof SaveOpenRouterKeyRequestSchema
>;

/**
 * A turn of the conversation: a message from the user or from the assistant. Clients send
 * only turns. Instructions for the model are added by the backend, never by the client.
 */
export const ChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z
    .string()
    .refine((text) => text.trim() !== "", "Each message must have text"),
});
/**
 * One turn of a conversation, as the user or the assistant sees it.
 */
export type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * A list of conversation turns.
 */
export const ChatMessageListSchema = z.array(ChatMessageSchema);

/**
 * The body of POST /api/chat: the model, the conversation, and whether tools may be offered.
 */
export const ChatRequestSchema = z.object({
  model: z.string().trim().min(1),
  /** The whole conversation so far, ending with the user's new message. */
  messages: ChatMessageListSchema.min(1).refine(
    (messages) => messages[messages.length - 1]?.role === "user",
    "The last message must be from the user",
  ),
  /** False offers the model no tools, so the reply can only be text. Defaults to true. */
  allowTools: z.boolean().optional(),
  /** The id of a profile note whose instructions the backend adds to the conversation. */
  profileId: z.string().min(1).optional(),
});
/**
 * The body of POST /api/chat.
 */
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/**
 * One event in the chat reply stream. A reply ends with exactly one "done" or "error" event.
 */
export const ChatStreamEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("delta"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string() }),
  // The exact prompt tokens OpenRouter counted for the request that produced the reply.
  z.object({ type: z.literal("usage"), promptTokens: z.number() }),
  // The model proposed a change that needs the user's approval. The reply waits until the
  // user answers at POST /api/approvals/:id.
  z.object({
    type: z.literal("approval"),
    id: z.string(),
    title: z.string(),
    body: z.string(),
  }),
]);
/**
 * One event in the chat reply stream: text, a proposed change, a usage count, or the end of the reply.
 */
export type ChatStreamEvent = z.infer<typeof ChatStreamEventSchema>;

/**
 * The body of POST /api/approvals/:id: whether the user approved the change.
 */
export const ApprovalDecisionSchema = z.object({ approved: z.boolean() });
/**
 * The body of POST /api/approvals/:id.
 */
export type ApprovalDecision = z.infer<typeof ApprovalDecisionSchema>;

/**
 * The reply to a recorded approval decision.
 */
export const ApprovalAckSchema = z.object({ ok: z.literal(true) });

/**
 * Checks one untrusted value against the ChatStreamEvent contract.
 *
 * @param value The untrusted value.
 * @returns The checked event, or an error when the value is not a known event.
 */
export function parseChatStreamEvent(
  value: unknown,
): Result<ChatStreamEvent, ParseError> {
  return parseValue(ChatStreamEventSchema, value);
}

/**
 * Checks an untrusted list of conversation turns.
 *
 * @param value The untrusted value.
 * @returns The checked messages, or an error when the value is not a list of turns.
 */
export function parseChatMessageList(
  value: unknown,
): Result<ChatMessage[], ParseError> {
  return parseValue(ChatMessageListSchema, value);
}

/**
 * One note: a named piece of text with a category, a short summary, and its content.
 */
export const NoteSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string(),
  summary: z.string(),
  content: z.string(),
});
/**
 * One note.
 */
export type Note = z.infer<typeof NoteSchema>;

/**
 * The fields a note is written with. The name and category must not be blank.
 */
export const NoteInputSchema = z.object({
  name: z.string().trim().min(1, "A note needs a name"),
  category: z.string().trim().min(1, "A note needs a category"),
  summary: z.string(),
  content: z.string(),
});
/**
 * The fields a note is written with.
 */
export type NoteInput = z.infer<typeof NoteInputSchema>;

/**
 * The reply of GET /api/notes: every note.
 */
export const NotesResponseSchema = z.object({ notes: z.array(NoteSchema) });
/**
 * The reply of GET /api/notes.
 */
export type NotesResponse = z.infer<typeof NotesResponseSchema>;

/**
 * The category that marks a note as a profile: its content is system instructions for the model.
 */
export const PROFILE_CATEGORY = "profile";

/**
 * A reply that only confirms a request was received and handled.
 */
export const OkResponseSchema = z.object({ ok: z.literal(true) });
/**
 * A reply that only confirms a request was received and handled.
 */
export type OkResponse = z.infer<typeof OkResponseSchema>;

/**
 * The shell commands a user sets for the four lifecycle events. Each is optional; blank means unset.
 */
export const HooksSchema = z.object({
  beforeSession: z.string().min(1).optional(),
  afterSession: z.string().min(1).optional(),
  beforeTurn: z.string().min(1).optional(),
  afterTurn: z.string().min(1).optional(),
});
/**
 * The commands for the four lifecycle events.
 */
export type Hooks = z.infer<typeof HooksSchema>;

/**
 * The reply of GET /api/hooks: the global commands, and the commands of each profile by id.
 */
export const HooksResponseSchema = z.object({
  global: HooksSchema,
  profiles: z.record(z.string(), HooksSchema),
});
/**
 * The reply of GET /api/hooks.
 */
export type HooksResponse = z.infer<typeof HooksResponseSchema>;

/**
 * The body of POST /api/session/end: the profile the ending session used, if any.
 */
export const EndSessionRequestSchema = z.object({
  profileId: z.string().min(1).optional(),
});
/**
 * The body of POST /api/session/end.
 */
export type EndSessionRequest = z.infer<typeof EndSessionRequestSchema>;
