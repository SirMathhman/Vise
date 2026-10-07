import type { ServerMessage } from "./server-message.ts";

/** A message sent while the agent works, in one of the two ways. */
export type SendMode = "steer" | "queue";

interface Held {
  text: string;
  /** Called when the line starts, to put it in the chat log. */
  show: () => void;
}

export interface SteerUi {
  /** A line's turn is in flight (the composer stays usable so the user can steer or queue). */
  readonly running: boolean;
  setRunning(on: boolean): void;
  /** Hold a line until the work in flight is done. */
  hold(text: string, images: unknown[], show: () => void): void;
  /** Steer the turn: the words reach the agent before its next step. */
  steer(text: string, images: unknown[]): void;
  handle(message: ServerMessage): boolean;
}

/**
 * Steering and queueing. While a turn runs the send button is replaced by two:
 * "steer" (Enter) reaches the agent before its next step, "queue" (Ctrl+Enter)
 * waits until the whole task is done. Held messages are listed above the
 * composer and can be removed until they start. The server owns the queue; the
 * page only draws it.
 */
export function createSteerUi(deps: {
  sendMessage: (msg: Record<string, unknown>) => void;
  /** Called when a held line starts (the page is busy again). */
  started: (text: string) => void;
  notice: (text: string) => void;
  list: HTMLElement;
  steerBtn: HTMLButtonElement;
  queueBtn: HTMLButtonElement;
}): SteerUi {
  const held = new Map<string, Held>();
  let nextQid = 0;
  let running = false;

  function render(items: { qid: string; text: string }[]): void {
    deps.list.textContent = "";
    deps.list.classList.toggle("hidden", items.length === 0);
    if (items.length === 0) return;
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = `Queued · runs after the current task (${items.length})`;
    deps.list.append(title);
    for (const { qid, text } of items) {
      const row = document.createElement("div");
      row.className = "queue-row";
      const label = document.createElement("span");
      label.className = "queue-text";
      label.textContent = text;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "queue-remove";
      remove.title = "Remove from the queue";
      remove.setAttribute("aria-label", `Remove queued message: ${text}`);
      remove.textContent = "✕";
      remove.addEventListener("click", () =>
        deps.sendMessage({ type: "unqueue", qid }),
      );
      row.append(label, remove);
      deps.list.append(row);
    }
  }

  return {
    get running() {
      return running;
    },
    setRunning(on) {
      running = on;
      deps.steerBtn.classList.toggle("hidden", !on);
      deps.queueBtn.classList.toggle("hidden", !on);
    },
    hold(text, images, show) {
      const qid = `q${nextQid++}`;
      held.set(qid, { text, show });
      deps.sendMessage({ type: "line", text, images, qid });
    },
    steer(text, images) {
      deps.sendMessage({ type: "steer", text, images });
    },
    handle(message) {
      if (message.type === "queue") {
        const items = message.items ?? [];
        const live = new Set(items.map((i) => i.qid));
        for (const qid of held.keys()) if (!live.has(qid)) held.delete(qid);
        render(items);
        return true;
      }
      if (message.type === "line_started") {
        const entry = message.qid === undefined ? undefined : held.get(message.qid);
        if (message.qid !== undefined) held.delete(message.qid);
        entry?.show();
        deps.started(message.text ?? "");
        return true;
      }
      if (message.type === "notice") {
        deps.notice(message.text ?? "");
        return true;
      }
      return false;
    },
  };
}
