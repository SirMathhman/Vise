import { appendPicture } from "./lightbox.ts";
import type { TranscriptView } from "./transcript.ts";

/** One restored line of the conversation (the shape `src/web/history.ts` sends). */
export type HistoryEntry =
  | { kind: "user"; text: string; images: { id: string; label: string }[] }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; text: string }
  | { kind: "image"; id: string; label: string }
  | { kind: "note"; text: string };

const imageUrl = (id: string): string => `/api/image/${id}`;

/** Show a picture the server stored (a tool's screenshot, say) as a thumbnail. */
export function showImage(
  transcript: TranscriptView,
  image: { id?: string; label?: string },
): void {
  appendPicture(transcript, imageUrl(image.id ?? ""), image.label ?? "image");
}

/** Replace the chat log with a restored conversation. */
export function replayHistory(
  transcript: TranscriptView,
  restored: { name?: string; entries?: HistoryEntry[] },
): void {
  transcript.clear();
  if (restored.name) {
    transcript.addLine("system", `resumed session '${restored.name}'`);
  }
  for (const entry of restored.entries ?? []) {
    switch (entry.kind) {
      case "user":
        transcript.addLine("user", entry.text);
        for (const image of entry.images) {
          appendPicture(transcript, imageUrl(image.id), image.label);
        }
        break;
      case "assistant":
        transcript.appendAssistantToken(entry.text);
        transcript.flushAssistant();
        break;
      case "tool":
        transcript.appendToolCall(entry.name, 0, entry.text);
        break;
      case "image":
        appendPicture(transcript, imageUrl(entry.id), entry.label);
        break;
      case "note":
        transcript.addLine("system", entry.text);
        break;
    }
  }
}
