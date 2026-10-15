/** What the page-wide keys act on. */
export interface ShortcutTargets {
  toggleFiles(): void;
  openSettings(): void;
  /** Interrupt the running turn; false when nothing is running. */
  stop(): boolean;
  focusComposer(): void;
  /** Whether a menu, dropdown, page or dialog is open (Escape is theirs then). */
  overlayOpen(): boolean;
}

/** The shortcuts, for the help dialog and the menus (one list, so they cannot disagree). */
export const SHORTCUTS: [keys: string, what: string][] = [
  ["Enter", "Send (while the agent works: steer it)"],
  ["Ctrl+Enter", "Queue for after the running task"],
  ["Shift+Enter", "New line in the message"],
  ["↑ / ↓", "Bring back earlier messages (in an empty box)"],
  ["Esc", "Stop the running turn (in the message box); close menus and pages"],
  ["/", "Focus the message box"],
  ["Ctrl+B", "Show or hide the files"],
  ["Ctrl+`", "Show or hide the terminal"],
  ["Ctrl+,", "Settings"],
];

/** Whether keys typed now go into a field (so "/" must not be taken from it). */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) ||
    !!target.closest(".xterm")
  );
}

/** Bind the page-wide keyboard shortcuts. */
export function bindShortcuts(targets: ShortcutTargets): void {
  document.addEventListener(
    "keydown",
    (event) => {
      if (event.defaultPrevented) return;
      const ctrl = event.ctrlKey || event.metaKey;
      const inShell = !!(event.target as Element | null)?.closest?.(".xterm");
      if (ctrl && !event.shiftKey && !event.altKey && !inShell && event.key.toLowerCase() === "b") {
        event.preventDefault();
        targets.toggleFiles();
      } else if (ctrl && event.key === ",") {
        event.preventDefault();
        targets.openSettings();
      } else if (event.key === "Escape" && !targets.overlayOpen()) {
        // In the message box, unless its suggestions are open (Escape closes those).
        const box = event.target as HTMLElement | null;
        const inComposer = box?.id === "input" && box.getAttribute("aria-expanded") !== "true";
        if (inComposer && targets.stop()) event.preventDefault();
      } else if (event.key === "/" && !ctrl && !typing(event.target) && !targets.overlayOpen()) {
        event.preventDefault();
        targets.focusComposer();
      }
      // Capture: seen before the menus close themselves on Escape, so closing a menu never also stops the turn.
    },
    true,
  );
}

/** A dialog listing the shortcuts. */
export function showShortcuts(): void {
  const dialog = document.createElement("dialog");
  dialog.className = "confirm-dialog";
  dialog.setAttribute("aria-labelledby", "shortcuts-title");
  const title = dialog.appendChild(document.createElement("h2"));
  title.id = "shortcuts-title";
  title.className = "confirm-title";
  title.textContent = "Keyboard shortcuts";
  const list = dialog.appendChild(document.createElement("dl"));
  list.className = "shortcut-list";
  for (const [keys, what] of SHORTCUTS) {
    const term = list.appendChild(document.createElement("dt"));
    term.appendChild(document.createElement("kbd")).textContent = keys;
    list.appendChild(document.createElement("dd")).textContent = what;
  }
  const row = dialog.appendChild(document.createElement("div"));
  row.className = "actions confirm-actions";
  const close = row.appendChild(document.createElement("button"));
  close.type = "button";
  close.className = "btn btn--lg btn--primary";
  close.textContent = "Close";
  close.addEventListener("click", () => {
    dialog.close();
    dialog.remove();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.appendChild(dialog);
  dialog.showModal();
  close.focus();
}
