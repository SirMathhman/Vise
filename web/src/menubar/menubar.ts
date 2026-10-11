import type { PanelGroup, PanelHandle } from "../status/panel-switch.ts";
import { menuKey, neighbourMenu, type KeyItem } from "./menu-keys.ts";

/** One line of a menu. */
export type MenuEntry =
  | {
      kind: "item";
      label: string;
      /** Shown at the right, e.g. "Ctrl+B". */
      shortcut?: string;
      /** A second, dimmer line (a session's age, a folder's path). */
      detail?: string;
      /** A checkbox item (`menuitemcheckbox`) when set. */
      checked?: boolean;
      /** With `checked`: one of a group (`menuitemradio`). */
      radio?: boolean;
      disabled?: boolean;
      run: () => void;
    }
  | { kind: "separator" }
  | { kind: "heading"; label: string };

export interface MenuSpec {
  trigger: HTMLButtonElement;
  /** Built afresh every time the menu opens, so it always shows the current state. */
  entries: () => MenuEntry[];
}

export interface Menubar {
  /** Rebuild the open menu (its data changed while it was open). */
  refresh(): void;
}

function renderEntry(entry: MenuEntry, choose: (run: () => void) => void): HTMLElement {
  if (entry.kind === "separator") {
    const line = document.createElement("div");
    line.className = "menu-separator";
    line.setAttribute("role", "separator");
    return line;
  }
  if (entry.kind === "heading") {
    const head = document.createElement("div");
    head.className = "menu-heading";
    head.setAttribute("role", "presentation");
    head.textContent = entry.label;
    return head;
  }
  const item = document.createElement("button");
  item.type = "button";
  item.className = "menu-item";
  item.tabIndex = -1;
  const role =
    entry.checked === undefined ? "menuitem" : entry.radio ? "menuitemradio" : "menuitemcheckbox";
  item.setAttribute("role", role);
  if (entry.checked !== undefined) item.setAttribute("aria-checked", String(entry.checked));
  item.disabled = entry.disabled === true;
  const mark = item.appendChild(document.createElement("span"));
  mark.className = "menu-mark";
  mark.setAttribute("aria-hidden", "true");
  if (entry.checked) mark.textContent = entry.radio ? "•" : "✓";
  const text = item.appendChild(document.createElement("span"));
  text.className = "menu-text";
  text.textContent = entry.label;
  if (entry.detail) {
    const detail = text.appendChild(document.createElement("span"));
    detail.className = "menu-detail";
    detail.textContent = entry.detail;
  }
  if (entry.shortcut) {
    const keys = item.appendChild(document.createElement("kbd"));
    keys.className = "menu-shortcut";
    keys.textContent = entry.shortcut;
    item.setAttribute("aria-keyshortcuts", entry.shortcut.replaceAll("Ctrl", "Control"));
  }
  item.addEventListener("click", () => choose(entry.run));
  return item;
}

/**
 * A menu bar (Session · View · Agent): each trigger opens a popup menu built
 * from its entries when it opens. Menus join the top bar's panel group, so at
 * most one menu or dropdown is open and Escape or a click elsewhere closes it.
 * Keyboard: Enter, Space or ↓ on a trigger opens its menu on the first item;
 * inside, the rules of `menuKey`; while one menu is open, pointing at another
 * trigger opens that one instead.
 */
export function createMenubar(menus: MenuSpec[], group: PanelGroup): Menubar {
  const handles: PanelHandle[] = [];
  const popups: HTMLElement[] = [];
  const items = (index: number): HTMLButtonElement[] =>
    Array.from(popups[index]?.querySelectorAll<HTMLButtonElement>(".menu-item") ?? []);
  const keyItems = (index: number): KeyItem[] =>
    items(index).map((item) => ({
      label: item.querySelector(".menu-text")?.firstChild?.textContent ?? "",
      enabled: !item.disabled,
    }));

  const focusFirst = (index: number): void => {
    const first = items(index).find((item) => !item.disabled);
    first?.focus();
  };
  const render = (index: number): void => {
    const popup = popups[index];
    const spec = menus[index];
    if (!popup || !spec) return;
    popup.textContent = "";
    const choose = (run: () => void): void => {
      handles[index]?.close();
      spec.trigger.focus();
      run();
    };
    for (const entry of spec.entries()) popup.appendChild(renderEntry(entry, choose));
  };
  const openAt = (index: number, focus: boolean): void => {
    handles[index]?.open();
    if (focus) focusFirst(index);
  };

  menus.forEach((spec, index) => {
    const { trigger } = spec;
    const popup = document.createElement("div");
    popup.className = "menu hidden";
    popup.id = `${trigger.id}-menu`;
    popup.setAttribute("role", "menu");
    popup.setAttribute("aria-labelledby", trigger.id);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.after(popup);
    popups.push(popup);
    handles.push(group.register({ button: trigger, panel: popup, onOpen: () => render(index) }));
    // A keyboard click (detail 0) lands on the first item; a mouse click leaves the focus on the trigger.
    trigger.addEventListener("click", (event) => {
      if (event.detail === 0 && handles[index]?.isOpen()) focusFirst(index);
    });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        openAt(index, true);
      } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        const next = neighbourMenu(index, event.key === "ArrowLeft" ? -1 : 1, menus.length);
        menus[next]?.trigger.focus();
      }
    });
    trigger.addEventListener("pointerenter", () => {
      const other = handles.findIndex((handle, i) => i !== index && handle.isOpen());
      if (other >= 0) openAt(index, false);
    });
    popup.addEventListener("keydown", (event) => {
      const list = items(index);
      const active = list.indexOf(document.activeElement as HTMLButtonElement);
      const action = menuKey(event.key, keyItems(index), active);
      if (action.kind === "none") return;
      event.preventDefault();
      event.stopPropagation();
      if (action.kind === "move") list[action.index]?.focus();
      else if (action.kind === "activate") list[active]?.click();
      else if (action.kind === "close") {
        handles[index]?.close();
        trigger.focus();
      } else {
        const next = neighbourMenu(index, action.direction, menus.length);
        openAt(next, true);
      }
    });
    popup.addEventListener("pointermove", (event) => {
      const item = (event.target as Element).closest<HTMLButtonElement>(".menu-item");
      if (item && !item.disabled && document.activeElement !== item) item.focus();
    });
  });

  return {
    refresh() {
      const open = handles.findIndex((handle) => handle.isOpen());
      if (open >= 0) render(open);
    },
  };
}
