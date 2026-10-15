import { z } from "zod";
import type { Message, Picture, ToolCall } from "../errors.ts";

export const pictureSchema: z.ZodType<Picture> = z.object({
  id: z.string(),
  mime: z.string(),
  label: z.string(),
  bytes: z.number(),
  width: z.number().optional(),
  height: z.number().optional(),
  quiet: z.boolean().optional(),
}) as z.ZodType<Picture>;

export const picturesArraySchema: z.ZodType<Picture[]> = z.array(
  pictureSchema,
) as z.ZodType<Picture[]>;

export const toolCallSchema: z.ZodType<ToolCall> = z.object({
  type: z.literal("function"),
  id: z.string(),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }),
}) as z.ZodType<ToolCall>;

export const toolCallsArraySchema: z.ZodType<ToolCall[]> = z.array(
  toolCallSchema,
) as z.ZodType<ToolCall[]>;

export const messageSchema: z.ZodType<Message> = z.object({
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  typed: z.boolean().optional(),
  images: picturesArraySchema.optional(),
  tool_calls: toolCallsArraySchema.optional(),
  tool_call_id: z.string().optional(),
}) as z.ZodType<Message>;
