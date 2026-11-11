// The auto-scroll toggle: while it is on, the transcript stays at its newest message; while it is off, the reader
// may scroll back through the conversation. Turning it on jumps to the bottom (the page does that on render).

export interface AutoScrollActions {
  toggleAutoScroll(): void;
}

export interface AutoScroll {
  element: HTMLButtonElement;
  update(following: boolean): void;
}

export function autoScrollButton(doc: Document, actions: AutoScrollActions): AutoScroll {
  const element = doc.createElement("button");
  element.type = "button";
  element.className = "auto-scroll";
  element.addEventListener("click", () => actions.toggleAutoScroll());
  return {
    element,
    update(following) {
      element.textContent = following ? "Auto-scroll: on" : "Auto-scroll: off";
      element.setAttribute("aria-pressed", String(following));
    },
  };
}
