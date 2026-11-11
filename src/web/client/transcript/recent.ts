// The part of the transcript the page builds. A long chat builds only its most recent blocks; a button shows the
// blocks before them, a step at a time. The whole transcript stays in the page's state.

// How many blocks the page builds at first, and how many more each press of the button adds.
export const RECENT_BLOCKS = 200;

export interface RecentActions {
  showEarlier(): void;
}

// The button that shows the blocks before the ones built. Shown only while some are not built.
export function earlierButton(doc: Document, hidden: number, actions: RecentActions): HTMLElement {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "earlier";
  button.textContent = `Show ${Math.min(hidden, RECENT_BLOCKS)} earlier messages (${hidden} not shown)`;
  button.addEventListener("click", () => actions.showEarlier());
  return button;
}
