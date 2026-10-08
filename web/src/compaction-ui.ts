import type { ServerMessage } from "./server-message.ts";

/** What the marker says while the summary is being written, and once it is. */
export const COMPACTING = "🗜 Compacting the conversation…";
export const COMPACTED = "🗜 Conversation compacted";

/**
 * Marks in the log when the conversation is compacted: a line appears as soon as
 * the summarising call starts (it can take a while to read and write) and turns
 * into "compacted" when the call ends. It stays, so the log shows where the
 * earlier conversation was folded into a summary.
 */
export function createCompactionMarker(
  addLine: (cls: string, text: string) => HTMLElement,
): { observe(message: ServerMessage): void } {
  let open: { request: number | undefined; line: HTMLElement } | null = null;
  return {
    observe(message) {
      if (message.purpose !== "compaction") return;
      if (message.type !== "progress" && message.type !== "generating") return;
      if (message.type === "generating" && message.used !== undefined) return;
      if (open && open.request !== message.request) open = null;
      if (!open) {
        if (message.type === "generating" && message.done === true) return;
        open = { request: message.request, line: addLine("system compaction", COMPACTING) };
      }
      if (message.type === "generating" && message.done === true) {
        open.line.textContent = COMPACTED;
        open = null;
      }
    },
  };
}
