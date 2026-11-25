/**
 * The text of an error, whatever was thrown.
 */
export function errorMessage(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * Returns the element with this id. Throws at startup if the page is missing it.
 */
export function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing element #${id}`);
  }
  return el;
}
