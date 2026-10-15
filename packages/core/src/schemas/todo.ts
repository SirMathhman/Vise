import { z } from "zod";
import type { TodoItem } from "../todos.ts";

export const todoItemSchema: z.ZodType<TodoItem> = z.object({
  content: z.string().min(1),
  status: z.enum(["pending", "in_progress", "completed"]),
}) as z.ZodType<TodoItem>;

export const todosSchema: z.ZodType<TodoItem[]> = z.array(todoItemSchema) as z.ZodType<TodoItem[]>;
