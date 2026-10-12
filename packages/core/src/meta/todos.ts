import type { Result } from "../errors.ts";

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

const STATUSES: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

const isStatus = (value: unknown): value is TodoStatus =>
  typeof value === "string" && STATUSES.includes(value as TodoStatus);

/** Check a todo list that came from the model or from storage. */
export function parseTodos(value: unknown): Result<TodoItem[]> {
  const bad = (body: string): Result<TodoItem[]> => ({
    ok: false,
    error: { kind: "malformed", body },
  });
  if (!Array.isArray(value)) return bad("`todos` must be a list of items");
  const items: TodoItem[] = [];
  for (const [i, raw] of value.entries()) {
    const item = raw as { content?: unknown; status?: unknown } | null;
    const content =
      typeof item?.content === "string" ? item.content.trim() : "";
    if (content === "") return bad(`todo ${i + 1} has no \`content\``);
    if (!isStatus(item?.status)) {
      return bad(
        `todo ${i + 1} needs a \`status\` of ${STATUSES.join(", ")}`,
      );
    }
    items.push({ content, status: item.status });
  }
  return { ok: true, value: items };
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
