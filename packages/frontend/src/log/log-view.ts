import { renderMarkdown } from "../markdown.ts";
import { createTranscript } from "../transcript/transcript.ts";
import type { TranscriptView } from "../transcript/transcript.ts";

/**
 * The chat log and the small things around it: the "↓ latest" button that
 * appears while the reader has scrolled up, and a quiet status line for screen
 * readers (the log itself is not a live region: every streamed token would be
 * announced). `?bench=<lines>` measures how the log copes with a long chat.
 */
export function createLogView(
  log: HTMLElement,
  jumpButton: HTMLElement,
  status: HTMLElement,
): { transcript: TranscriptView; announce(text: string): void } {
  const transcript = createTranscript(log, renderMarkdown, (pinned) =>
    jumpButton.classList.toggle("hidden", pinned),
  );
  jumpButton.addEventListener("click", () => transcript.scrollToBottom());
  const bench = new URLSearchParams(location.search).get("bench");
  if (bench) {
    (window as unknown as { __transcript: TranscriptView }).__transcript =
      transcript;
    // A development tool: clamp what a link can ask for so it cannot freeze the page.
    const lines = Math.min(Math.max(Math.floor(Number(bench)) || 0, 1), 20_000);
    void import("./bench.ts").then((m) => m.runBench(transcript, lines));
  }
  return {
    transcript,
    announce(text) {
      status.textContent = text;
    },
  };
}
