export interface MenuItem {
  label: string;
  disabled?: boolean;
  /** Destroys something (shown in red). */
  danger?: boolean;
  run(): void;
}

let current: HTMLElement | null = null;

/** Dismiss the open context menu, if any. */
export function closeMenu(): void {
  current?.remove();
  current = null;
}

/** Show a small context menu at the given viewport position; it closes on any outside click, Escape, or scroll. */
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  closeMenu();
  const menu = document.createElement("div");
  menu.className = "ctx-menu";
  menu.setAttribute("role", "menu");
  for (const item of items) {
    const row = document.createElement("button");
    row.className = item.danger ? "ctx-item danger" : "ctx-item";
    row.type = "button";
    row.setAttribute("role", "menuitem");
    row.textContent = item.label;
    row.disabled = item.disabled === true;
    row.addEventListener("click", () => {
      closeMenu();
      item.run();
    });
    menu.appendChild(row);
  }
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  document.body.appendChild(menu);
  current = menu;
  // Keep the menu inside the viewport.
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - box.width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - box.height))}px`;
}

document.addEventListener("pointerdown", (e) => {
  if (current && !current.contains(e.target as Node)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeMenu();
});
window.addEventListener("blur", closeMenu);
