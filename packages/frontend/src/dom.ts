/**
 * The text of an error, whatever was thrown.
 *
 * @param failure The value that was thrown.
 * @returns The message text.
 */
export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Returns the element with this id. Throws at startup if the page is missing it.
 *
 * @param id The element id to look up.
 * @returns The element.
 */
export function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}
