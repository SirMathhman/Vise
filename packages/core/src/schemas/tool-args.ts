import { z } from "zod";

/**
 * Validate the parsed JSON of a tool call's `arguments` field before dispatching
 * to a handler. The shape is `{ name: string, arguments: Record }`.
 */
export const toolCallArgsSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});

export type ToolCallArgs = z.infer<typeof toolCallArgsSchema>;
