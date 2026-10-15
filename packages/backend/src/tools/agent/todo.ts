import { formatTodos, parseTodos, type TodoItem, type TodoStore } from "@vise/core";
import { formatError } from "../../output/format.ts";

/** The agent's todo list for one session; listeners hear every change (the web panel). */
export class TodoBoard implements TodoStore {
  private items: TodoItem[] = [];

  constructor(private readonly onChange?: (items: TodoItem[]) => void) {}

  get(): TodoItem[] {
    return this.items;
  }

  set(items: TodoItem[]): void {
    this.items = items;
    this.onChange?.(items);
  }
}

/** Models often send a list as JSON text; accept both. */
function listArg(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Edge handler for `todo_write`: replace the whole list and echo it back. */
export function makeTodoHandler(board: TodoStore): (args: Record<string, unknown>) => string {
  return (args) => {
    const parsed = parseTodos(listArg(args.todos));
    if (!parsed.ok) return `error: ${formatError(parsed.error)}`;
    board.set(parsed.value);
    return formatTodos(parsed.value);
  };
}
