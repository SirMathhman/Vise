// The chat utilities: a button by the message box that shows or hides a popover over the composer. The popover holds
// the utility panels (saved sessions, tools, profiles, MCP servers, providers), so they are reachable from the bottom
// of a long chat without scrolling back up.

export interface Utilities {
  button: HTMLButtonElement;
  panel: HTMLElement;
}

export function utilitiesOf(doc: Document, panels: HTMLElement[]): Utilities {
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "utilities-button";
  button.textContent = "Utilities";
  button.setAttribute("aria-expanded", "false");
  const panel = doc.createElement("div");
  panel.className = "utilities";
  panel.hidden = true;
  panel.append(...panels);
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
  return { button, panel };
}
