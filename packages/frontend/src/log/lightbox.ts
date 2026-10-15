import type { TranscriptView } from "../transcript/transcript.ts";

/** Show a picture full size over the page; a click, or Escape, closes it. */
export function openLightbox(uri: string, label: string): void {
  const overlay = document.createElement("div");
  overlay.className = "lightbox";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", label);
  const image = document.createElement("img");
  image.src = uri;
  image.alt = label;
  overlay.append(image);
  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === "Escape") close();
  };
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", onKey);
  document.body.append(overlay);
}

/** Add a picture to the transcript as a thumbnail; a click enlarges it. */
export function appendPicture(transcript: TranscriptView, uri: string, label: string): void {
  transcript.flushAssistant();
  transcript.finishThinking();
  const image = document.createElement("img");
  // Only pictures near the view are fetched and decoded, so a long chat does not load them all.
  image.loading = "lazy";
  image.decoding = "async";
  image.src = uri;
  image.alt = label;
  image.title = `${label} (click to enlarge)`;
  image.addEventListener("click", () => openLightbox(uri, label));
  transcript.addLine("image", "").append(image);
}
