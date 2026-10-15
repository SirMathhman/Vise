import type { Result } from "../errors.ts";
import { parse } from "../schemas/parse.ts";
import { todosSchema } from "../schemas/todo.ts";

export type TodoStatus = "pending" | "in_progress" | "completed";

/** One step of the agent's own task list. */
export interface TodoItem {
  content: string;
  status: TodoStatus;
}

/** Where the session keeps the agent's todo list (read when saving, replaced on resume and `/new`). */
export interface TodoStore {
  get(): TodoItem[];
  set(items: TodoItem[]): void;
}

/** Check a todo list that came from the model or from storage. */
export function parseTodos(value: unknown): Result<TodoItem[]> {
  return parse(todosSchema, value);
}

const MARKS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

/** The list as text, one `[mark] content` line per item. */
export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "todo list is empty";
  return items.map((t) => `${MARKS[t.status]} ${t.content}`).join("\n");
}
