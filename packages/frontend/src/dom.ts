/** A new element with an optional class list and text (the page builds most of its panels this way). */
export function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text) element.textContent = text;
  return element;
}

/** An element of index.html by id; a missing one is a build error, not something to handle. */
export function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing required element #${id}`);
  return element as T;
}

/** Whether this page is the Firefox extension's sidebar (`/?ui=sidebar`). */
export const isSidebar = (): boolean =>
  new URLSearchParams(location.search).get("ui") === "sidebar";
