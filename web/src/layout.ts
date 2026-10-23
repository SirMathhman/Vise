// The widths of the side panels: each divider sets its panel, and the window decides how much room each one gets.

// The Tools panel beside the chat, whose width the user drags. The width is kept in this browser. The panel never takes
// more than the window leaves it after the chat's preferred width, so the panel never pushes the chat off screen.
interface ResizablePanel {
  panel: HTMLElement;
  divider: HTMLElement;
  cssVar: string;
  storageKey: string;
  min: number;
  // The pointer movement that widens the panel: 1 for a panel left of its divider, -1 for one right of it.
  direction: 1 | -1;
  // The width the user chose, or 0 for the default. It is kept as it is, so it comes back when the window grows.
  chosen: number;
}

const MIN_TOOLS_PX = 160;
// The chat's preferred width, 24rem. The panels leave it this much when they can, and it gives way in a narrow window.
const CHAT_PX = 384;
const layout = document.querySelector(".layout") as HTMLDivElement;
const main = document.querySelector("main") as HTMLElement;
const toolsPanel: ResizablePanel = {
  panel: document.querySelector("aside") as HTMLElement,
  divider: document.getElementById("divider") as HTMLDivElement,
  cssVar: "--tools-width",
  storageKey: "vise-tools-width",
  min: MIN_TOOLS_PX,
  direction: -1,
  chosen: 0,
};

// The most a panel may take: the window less the chat's preferred width and every other panel as it is now shown. A
// panel still gets its own minimum when the window is too narrow, and the chat gives way instead.
function roomFor(resizable: ResizablePanel): number {
  let others = 0;
  for (const child of Array.from(layout.children) as HTMLElement[]) {
    if (child !== main && child !== resizable.panel) {
      others += child.offsetWidth;
    }
  }
  return layout.clientWidth - others - CHAT_PX;
}

// Sets the chosen width to what fits.
function applyPanelWidths(): void {
  for (const resizable of [toolsPanel]) {
    if (resizable.chosen > 0) {
      const px = Math.max(resizable.min, Math.min(resizable.chosen, roomFor(resizable)));
      document.documentElement.style.setProperty(resizable.cssVar, `${px}px`);
    }
  }
}

// Dragging a divider sets its panel's width. The width follows the pointer from where the drag began.
function watchDivider(resizable: ResizablePanel): void {
  let drag: { x: number; width: number } | null = null;
  resizable.divider.addEventListener("pointerdown", (event) => {
    drag = { x: event.clientX, width: resizable.panel.getBoundingClientRect().width };
    resizable.divider.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  resizable.divider.addEventListener("pointermove", (event) => {
    if (drag !== null) {
      resizable.chosen = drag.width + resizable.direction * (event.clientX - drag.x);
      applyPanelWidths();
    }
  });
  function endDrag(): void {
    if (drag === null) {
      return;
    }
    drag = null;
    try {
      localStorage.setItem(resizable.storageKey, String(resizable.chosen));
    } catch {
      // Not saved: the width lasts for this page load only.
    }
  }
  resizable.divider.addEventListener("pointerup", endDrag);
  resizable.divider.addEventListener("pointercancel", endDrag);
}

// Restores the width this browser last used. Storage can be blocked, in which case the default width is used.
for (const resizable of [toolsPanel]) {
  try {
    const stored = Number(localStorage.getItem(resizable.storageKey));
    if (stored > 0) {
      resizable.chosen = stored;
    }
  } catch {
    // The default width stays.
  }
  watchDivider(resizable);
}
applyPanelWidths();
