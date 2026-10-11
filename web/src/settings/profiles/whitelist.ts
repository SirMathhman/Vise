import {
  appendToolCategory,
  appendToolItem,
  syncCategoryToggles,
} from "../panels.ts";

/** The tools ticked in a whitelist list (the category boxes only switch groups; they are not tools). */
export function checkedTools(list: HTMLUListElement): string[] {
  return Array.from(
    list.querySelectorAll<HTMLInputElement>(
      "li:not(.tool-category) input:checked",
    ),
    (el) => el.value,
  );
}

/** Tick or untick every tool in the list. */
export function setAllTools(list: HTMLUListElement, on: boolean): void {
  for (const box of list.querySelectorAll<HTMLInputElement>("input")) {
    box.checked = on;
    box.closest("li")?.classList.toggle("disabled", !on);
  }
  syncCategoryToggles(list);
}

/** Tick or untick every tool under a category heading row. */
function setGroup(head: Element, on: boolean): void {
  for (let row = head.nextElementSibling; row; row = row.nextElementSibling) {
    if (row.classList.contains("tool-category")) break;
    const box = row.querySelector<HTMLInputElement>("input");
    if (box) box.checked = on;
    row.classList.toggle("disabled", !on);
  }
}

/** A checkbox in the list changed: a tool dims its row, a category switches its whole group; then the category boxes are re-synced. */
export function applyToggle(
  list: HTMLUListElement,
  target: EventTarget | null,
): void {
  if (target instanceof HTMLInputElement) {
    const row = target.closest("li");
    if (row?.classList.contains("tool-category")) setGroup(row, target.checked);
    else row?.classList.toggle("disabled", !target.checked);
  }
  syncCategoryToggles(list);
}

/** Fill `list` with the tool checkboxes, grouped by category, ticking those in `allowed` (all when undefined). */
export function renderWhitelist(
  list: HTMLUListElement,
  tools: string[],
  categoryOf: (name: string) => string | undefined,
  allowed: string[] | undefined,
): void {
  list.textContent = "";
  let category: string | undefined;
  for (const tool of tools) {
    const next = categoryOf(tool);
    if (next !== undefined && next !== category) {
      category = next;
      appendToolCategory(list, next, true);
    }
    appendToolItem(list, tool, allowed?.includes(tool) ?? true);
  }
  syncCategoryToggles(list);
}
