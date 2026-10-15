import { z } from "zod";
import type { Workflow, WorkflowStep } from "../workflow.ts";

export const workflowStepSchema: z.ZodType<WorkflowStep> = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("instruction"),
    text: z.string().min(1),
  }),
  z.object({
    type: z.literal("profile"),
    name: z.string().min(1),
  }),
  z.object({
    type: z.literal("tool"),
    name: z.string().min(1),
    args: z.record(z.string(), z.unknown()),
    exact: z.boolean().optional(),
  }),
]) as z.ZodType<WorkflowStep>;

export const workflowSchema: z.ZodType<Workflow> = z.object({
  steps: z.array(workflowStepSchema),
}) as z.ZodType<Workflow>;
