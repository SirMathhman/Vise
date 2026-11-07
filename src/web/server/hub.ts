import type { ClientMessage, ServerEvent } from "../../protocol/protocol.ts";
import { parseClientMessage } from "./client-message.ts";

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
}

// The close code sent to a viewer that another tab replaced.
export const TAKEN_OVER = 4001;

export function createHub(forward: (message: ClientMessage) => void): Hub {
  const log: ServerEvent[] = [];
  let current: Viewer | undefined;
  let finished = false;
  return {
    publish(event) {
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
