/**
 * Shared keyboard-navigable menu behavior for the chat header's two
 * dropdowns: the Tools reference list (`tools.js`) and the conversation
 * switcher (`chat.js`). Both need the same ARIA menu wiring, so the keydown
 * handling and focus management live here (a leaf module: no local imports)
 * and each dropdown builds its own items with `role="menuitem"` +
 * `tabindex="-1"` and passes an `activate` callback for actionable menus.
 *
 * Keyboard contract (WAI-ARIA menu pattern):
 * - Open: focus moves to the first item (via the returned `open()`).
 * - Arrow Down / Arrow Up: move focus to the next/previous item (wrapping).
 * - Home / End: jump to the first/last item.
 * - Enter / Space: activate the focused item (calls `activate`, if any) —
 *   read-only menus (the Tools reference list) pass no `activate`, so Enter
 *   is a no-op.
 * - Escape: closing + focus return is handled by the owning module (which
 *   owns the trigger button and the open/close state).
 */

/**
 * Wires keyboard navigation into a dropdown menu.
 * @param {object} opts
 * @param {HTMLElement} opts.listEl - The `<ul role="menu">` container.
 * @param {(li: HTMLLIElement) => void} [opts.activate] - Called with the
 *   focused `<li role="menuitem">` when Enter/Space is pressed. Used by
 *   actionable menus (the conversation switcher); omit for read-only menus.
 * @returns {{ open: () => void }} `open()` moves focus to the first item so
 *   the menu is keyboard-reachable; safe to call when there are no items.
 */
export function setupKeyboardMenu({ listEl, activate }) {
  const items = () => Array.from(listEl.querySelectorAll('[role="menuitem"]'));

  listEl.addEventListener("keydown", (e) => {
    if (listEl.hidden) return;
    const list = items();
    if (!list.length) return;
    const focused = list.indexOf(e.target);
    const key = e.key;
    const isArrow =
      key === "ArrowDown" ||
      key === "Down" ||
      key === "ArrowUp" ||
      key === "Up";
    const isHome = key === "Home";
    const isEnd = key === "End";
    const isActivate = key === "Enter" || key === " ";
    if (!isArrow && !isHome && !isEnd && !isActivate) return;
    e.preventDefault();
    if (key === "ArrowDown" || key === "Down") {
      list[(focused + 1) % list.length].focus();
      return;
    }
    if (key === "ArrowUp" || key === "Up") {
      list[(focused - 1 + list.length) % list.length].focus();
      return;
    }
    if (isHome) {
      list[0].focus();
      return;
    }
    if (isEnd) {
      list[list.length - 1].focus();
      return;
    }
    if (focused >= 0 && activate) activate(list[focused]);
  });

  return {
    open() {
      const first = items()[0];
      if (first) first.focus();
    },
  };
}
