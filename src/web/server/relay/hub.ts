import type { ClientMessage, ServerEvent } from "../../../protocol/protocol.ts";
import { parseClientMessage } from "../client-message.ts";

// One browser connection. The hub sends it events, and closes it.
export interface Viewer {
  send(text: string): void;
  close(code: number, reason: string): void;
}

// Keeps every event of the session, so a browser that connects later (after a reload, or a dropped
// connection) gets the whole session again. Only one viewer is attached at a time.
export interface Hub {
  publish(event: ServerEvent): void;
  attach(viewer: Viewer): void;
  detach(viewer: Viewer): void;
  receive(viewer: Viewer, text: string): void;
  // Forgets the events kept so far, for a new session that replaces the old one. The viewer stays attached.
  reset(): void;
}

// The close code sent to a viewer that another tab replaced.
export const TAKEN_OVER = 4001;

// An answer to one page's request. It goes only to the page attached now, and is not kept, so a page that
// reloads does not get it again. A tree answer is kept: the page does not ask for it again on reconnect.
function isAnswer(event: ServerEvent): boolean {
  return event.kind === "file";
}

export function createHub(forward: (message: ClientMessage) => void): Hub {
  const log: ServerEvent[] = [];
  let current: Viewer | undefined;
  let finished = false;
  return {
    publish(event) {
      if (isAnswer(event)) {
        current?.send(JSON.stringify(event));
        return;
      }
      log.push(event);
      if (event.kind === "ended") finished = true;
      current?.send(JSON.stringify(event));
      if (finished) {
        const viewer = current;
        current = undefined;
        viewer?.close(1000, "session ended");
      }
    },
    attach(viewer) {
      const previous = current;
      current = viewer;
      previous?.close(TAKEN_OVER, "another tab took over this session");
      for (const event of log) viewer.send(JSON.stringify(event));
      if (finished) {
        current = undefined;
        viewer.close(1000, "session ended");
      }
    },
    detach(viewer) {
      if (current === viewer) current = undefined;
    },
    reset() {
      log.length = 0;
      finished = false;
    },
    receive(viewer, text) {
      if (viewer !== current) return;
      const parsed = parseClientMessage(text);
      if (!parsed.ok) {
        viewer.send(JSON.stringify({ kind: "error", message: parsed.error.message }));
        return;
      }
      forward(parsed.value);
    },
  };
}
