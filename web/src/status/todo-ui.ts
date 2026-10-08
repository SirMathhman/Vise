import type { ServerMessage } from "../server-message.ts";

const MARKS: Record<string, string> = {
  pending: "☐",
  in_progress: "▶",
  completed: "☑",
};

/** The agent's todo list above the composer: hidden when empty, redrawn whole on each `todos` message. */
export function createTodoUi(list: HTMLElement): {
  handle(message: ServerMessage): boolean;
} {
  return {
    handle(message) {
      if (message.type !== "todos") return false;
      const items = message.todos ?? [];
      list.textContent = "";
      list.classList.toggle("hidden", items.length === 0);
      if (items.length === 0) return true;
      const done = items.filter((t) => t.status === "completed").length;
      const title = document.createElement("div");
      title.className = "todos-title";
      title.textContent = `Todo · ${done}/${items.length} done`;
      list.append(title);
      for (const { content, status } of items) {
        const row = document.createElement("div");
        row.className = `todo-row todo-${status}`;
        const mark = document.createElement("span");
        mark.textContent = MARKS[status] ?? "☐";
        const text = document.createElement("span");
        text.textContent = content;
        row.append(mark, text);
        list.append(row);
      }
      return true;
    },
  };
}
