// Shows one panel at a time, so each panel fits the window without scrolling.
function showTab(name: string): void {
  for (const panel of document.querySelectorAll<HTMLElement>(
    "[data-tab-panel]",
  )) {
    panel.hidden = panel.dataset.tabPanel !== name;
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "nav.tabs button",
  )) {
    button.setAttribute("aria-pressed", String(button.dataset.tab === name));
  }
}

/**
 * Connects the tab buttons, so one panel shows at a time.
 */
export function initTabs(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(
    "nav.tabs button",
  )) {
    button.addEventListener("click", () => {
      showTab(button.dataset.tab ?? "chat");
    });
  }
}
