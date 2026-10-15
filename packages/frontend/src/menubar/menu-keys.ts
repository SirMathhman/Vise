/** What a key press inside an open menu does. */
export type MenuKeyAction =
  | { kind: "move"; index: number }
  | { kind: "activate" }
  | { kind: "close" }
  /** Open the menu next to this one (-1 left, 1 right) on the menu bar. */
  | { kind: "switch"; direction: -1 | 1 }
  | { kind: "none" };

/** One entry of an open menu as the key rules see it: its label and whether it can be chosen. */
export interface KeyItem {
  label: string;
  enabled: boolean;
}

/** The next enabled item from `from` in `step` direction, wrapping around; `from` when there is none. */
function nextEnabled(items: KeyItem[], from: number, step: 1 | -1): number {
  const n = items.length;
  for (let i = 1; i <= n; i++) {
    const at = (((from + step * i) % n) + n) % n;
    if (items[at]?.enabled) return at;
  }
  return from;
}

/** The first enabled item at or after `start` (wrapping) whose label starts with `letter`. */
function typeahead(items: KeyItem[], start: number, letter: string): number {
  const n = items.length;
  const wanted = letter.toLowerCase();
  for (let i = 0; i < n; i++) {
    const at = (start + i) % n;
    const item = items[at];
    if (item?.enabled && item.label.trim().toLowerCase().startsWith(wanted)) return at;
  }
  return -1;
}

/**
 * The keyboard rules of an open menu (the WAI-ARIA menu pattern): arrows move
 * through the enabled items and wrap, Home/End jump to the ends, a letter jumps
 * to the next item starting with it, Enter or Space chooses, Escape and Tab
 * close, and Left/Right move to the neighbouring menu on the bar. Pure, so the
 * rules are tested without a page.
 */
export function menuKey(key: string, items: KeyItem[], active: number): MenuKeyAction {
  if (items.length === 0) return key === "Escape" ? { kind: "close" } : { kind: "none" };
  switch (key) {
    case "ArrowDown":
      return { kind: "move", index: nextEnabled(items, active, 1) };
    case "ArrowUp":
      return { kind: "move", index: nextEnabled(items, active < 0 ? 0 : active, -1) };
    case "Home":
      return { kind: "move", index: nextEnabled(items, -1, 1) };
    case "End":
      return { kind: "move", index: nextEnabled(items, items.length, -1) };
    case "Enter":
    case " ":
      return active >= 0 && items[active]?.enabled ? { kind: "activate" } : { kind: "none" };
    case "Escape":
    case "Tab":
      return { kind: "close" };
    case "ArrowLeft":
      return { kind: "switch", direction: -1 };
    case "ArrowRight":
      return { kind: "switch", direction: 1 };
    default: {
      if (key.length !== 1 || key === " ") return { kind: "none" };
      const index = typeahead(items, active + 1, key);
      return index < 0 ? { kind: "none" } : { kind: "move", index };
    }
  }
}

/** The menu `direction` steps away from `index` on a bar of `count` menus, wrapping. */
export function neighbourMenu(index: number, direction: -1 | 1, count: number): number {
  return (((index + direction) % count) + count) % count;
}
