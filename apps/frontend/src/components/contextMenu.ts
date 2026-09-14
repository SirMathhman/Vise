export interface MenuItem {
  label: string;
  onClick: () => void;
}

/**
 * Build a single reusable context-menu element attached to the document body.
 * It is hidden by default and auto-hides on outside interaction, Escape, blur,
 * and resize.
 */
export function makeContextMenu(): HTMLDivElement {
  const menu = document.createElement("div");
  menu.id = "context-menu";
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  document.body.append(menu);
  document.addEventListener("click", () => hideMenu(menu));
  document.addEventListener("contextmenu", () => hideMenu(menu));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideMenu(menu);
  });
  window.addEventListener("blur", () => hideMenu(menu));
  window.addEventListener("resize", () => hideMenu(menu));
  menu.addEventListener("contextmenu", (e) => e.preventDefault());
  return menu;
}

export function hideMenu(menu: HTMLDivElement): void {
  menu.hidden = true;
}

/**
 * Populate the menu with the given items and show it at (x, y), clamped so it
 * stays within the viewport.
 */
export function showMenu(
  menu: HTMLDivElement,
  x: number,
  y: number,
  items: MenuItem[]
): void {
  menu.innerHTML = "";
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "menu-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      hideMenu(menu);
      item.onClick();
    });
    menu.append(btn);
  }
  menu.hidden = false;
  const rect = menu.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - rect.width - 6);
  const py = Math.min(y, window.innerHeight - rect.height - 6);
  menu.style.left = `${Math.max(6, px)}px`;
  menu.style.top = `${Math.max(6, py)}px`;
}
