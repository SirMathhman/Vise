import { z } from "zod";
import type { AuditEvent, AuditCall } from "../audit.ts";
import { messageSchema } from "./message.ts";

export const auditEventSchema: z.ZodType<AuditEvent> = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session_start"), session: z.string() }),
  z.object({ kind: z.literal("session_end") }),
  z.object({ kind: z.literal("link"), saved: z.string() }),
  z.object({ kind: z.literal("turn_start"), turn: z.string(), text: z.string() }),
  z.object({
    kind: z.literal("turn_end"),
    outcome: z.enum(["ok", "failed", "interrupted"]),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("message"),
    message: messageSchema,
    depth: z.number().optional(),
  }),
  z.object({
    kind: z.literal("model_call_start"),
    request: z.number(),
    purpose: z.string(),
    model: z.string(),
  }),
  z.object({
    kind: z.literal("model_call_progress"),
    request: z.number(),
    completionTokens: z.number(),
    raw: z.string(),
    rawReasoning: z.string(),
  }),
  z.object({
    kind: z.literal("model_call"),
    purpose: z.string(),
    model: z.string(),
    ms: z.number(),
    promptTokens: z.number().optional(),
    content: z.string().optional(),
    reasoning: z.string().optional(),
    toolCalls: z.number().optional(),
    error: z.string().optional(),
    request: z.number().optional(),
    raw: z.string().optional(),
    rawReasoning: z.string().optional(),
    completionTokens: z.number().optional(),
    finishReason: z.string().optional(),
    stopReason: z.string().optional(),
    loop: z.object({ period: z.number(), repeats: z.number() }).optional(),
  }),
  z.object({
    kind: z.literal("tool_call"),
    name: z.string(),
    args: z.unknown(),
    result: z.string(),
    ok: z.boolean(),
    ms: z.number(),
    depth: z.number(),
  }),
  z.object({
    kind: z.literal("hook_run"),
    phase: z.enum(["pre", "post", "pre_tool", "post_tool"]),
    command: z.string(),
    ms: z.number(),
    output: z.string(),
    tool: z.string().optional(),
    status: z.number().optional(),
  }),
  z.object({
    kind: z.literal("compaction"),
    summarized: z.number(),
    kept: z.number(),
    summary: z.string(),
  }),
  z.object({
    kind: z.literal("goal"),
    what: z.enum(["goal", "verdict", "setting"]),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("event"),
    name: z.string(),
    payload: z.unknown(),
  }),
]) as z.ZodType<AuditEvent>;

export const auditCallSchema: z.ZodType<AuditCall> = z.object({
  request: z.number(),
  purpose: z.string(),
  model: z.string(),
  state: z.enum(["running", "done", "stopped", "error", "abandoned"]),
  stopReason: z.string().optional(),
  ms: z.number(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  finishReason: z.string().optional(),
  toolCalls: z.number().optional(),
  error: z.string().optional(),
  rawChars: z.number().optional(),
  raw: z.string().optional(),
  reasoning: z.string().optional(),
  reasoningChars: z.number().optional(),
  loop: z
    .object({
      period: z.number(),
      repeats: z.number(),
      sample: z.string().optional(),
    })
    .optional(),
  startedAt: z.string().optional(),
}) as z.ZodType<AuditCall>;
